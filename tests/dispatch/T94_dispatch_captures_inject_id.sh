#!/usr/bin/env bash
# T94 (#872) — dispatch.sh must keep the inject_id telepty hands it.
#
# telepty 0.8.0 surfaces the transport id on its own stdout line
# (cli.js:2875 local arm, :2841 remote arm — plain text, stable `inject_id: `
# prefix, deliberately undecorated so a caller can scrape it). The consumer side
# already exists: dispatch-tracker.sh:158 reads `transport.inject_id` out of the
# ledger and :496 polls GET /api/inject-observations/:inject_id with it. But
# dispatch.sh never captured the id, so `transport.inject_id` was null on every
# record and dispatch-tracker.sh:501 resolved to `reason=no_transport_inject_id`
# forever. Deploying the 0.8.0 daemon was necessary and NOT sufficient.
#
# The id is human-facing stdout, not a machine contract. The required behaviour
# when it cannot be read cleanly is to record NO id and let the existing
# no_transport_inject_id path fire — never to invent, guess or partially match
# one. A wrong id makes the tracker poll someone else's record, which is worse
# than having none.
#
# HERMETIC: real dispatch.sh + real registry component against a temp state dir.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

fail() { echo "FAIL[T94]: $*" >&2; exit 1; }

# stub_inject <line…> — a telepty stub whose `inject` echoes exactly the given
# stdout lines, mimicking the real CLI's decorated success line plus whatever
# inject_id line the case under test needs.
stub_inject() {
  local body="" line
  for line in "$@"; do body+="$(printf '%s\n' "$line")"$'\n'; done
  cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
case "\$1" in
  list) shift; [ "\${1:-}" = "--json" ] && cat "$STUB_LIST_FILE";;
  inject)
    printf 'telepty inject %s\n' "\$*" >> "$STUB_DISPATCH_LOG"
    cat <<'STUBOUT'
$body
STUBOUT
    ;;
  *) echo "stub telepty \$*";;
esac
EOF
  chmod +x "$STUB_BIN/telepty"
}

# run_case <sid> — one full dispatch against the current stub; must exit 0.
run_case() {
  local sid="$1" ref="$T_TMP/ref-$1.md" rc=0
  printf 'payload for %s\n' "$sid" > "$ref"
  printf '%s' "[{\"id\":\"$sid\",\"command\":\"claude\",\"healthStatus\":\"CONNECTED\"}]" > "$STUB_LIST_FILE"
  set +e
  t_run_dispatch --target "$sid" --ref "$ref" --from orchestrator \
    --no-verify-started --no-task "test-fixture T94" >/dev/null 2>&1
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || fail "$sid: dispatch exit $rc, want 0"
}

OK_LINE="✅ Context injected successfully into 'sid'."

# ── A) the real 0.8.0 shape → the id is recorded ──
UUID="3a2a0e8e-1c4d-4f2b-9a77-8b1e5d6c0f31"
stub_inject "$OK_LINE" "   inject_id: $UUID"
run_case sid-happy-T94
t_assert_v2 sid-happy-T94 transport.result write_observed
t_assert_v2 sid-happy-T94 transport.inject_id "$UUID"
t_assert_outcome_unknown sid-happy-T94

# ── B) no id line at all (0.7.1 daemon, or a future CLI that stops printing it)
#      → NO id, so the existing no_transport_inject_id HOLD path still fires ──
stub_inject "$OK_LINE"
run_case sid-noid-T94
t_assert_v2 sid-noid-T94 transport.result write_observed
t_assert_v2 sid-noid-T94 transport.inject_id null

# ── C) malformed ids are never partially matched ──
# Each of these must yield null. A truncated or reshaped id is not a weaker id,
# it is a DIFFERENT record's id as far as the daemon is concerned.
i=0
for bad in \
  "   inject_id: 3a2a0e8e" \
  "   inject_id: 3a2a0e8e-1c4d-4f2b-9a77" \
  "   inject_id: 3a2a0e8e1c4d4f2b9a778b1e5d6c0f31" \
  "   inject_id: not-a-uuid-at-all-here-nope-nope" \
  "   inject_id:" \
  "   inject_id: 3a2a0e8e-1c4d-4f2b-9a77-8b1e5d6c0f31 trailing junk" \
  "   inject_id: zzzzzzzz-1c4d-4f2b-9a77-8b1e5d6c0f31"
do
  i=$((i + 1))
  stub_inject "$OK_LINE" "$bad"
  run_case "sid-bad$i-T94"
  got=$(t_v2 "sid-bad$i-T94" transport.inject_id)
  [ "$got" = "null" ] \
    || fail "C$i: malformed line [$bad] yielded inject_id=$got — a guessed id points the tracker at someone else's record"
done

# ── D) two DIFFERENT ids in one inject's output is ambiguity, not a menu ──
# Picking the first would be a guess. Record none and let the honest
# no_transport_inject_id path fire.
stub_inject "$OK_LINE" "   inject_id: $UUID" "   inject_id: 19800591-2b3c-4d5e-8f90-a1b2c3d4e5f6"
run_case sid-ambiguous-T94
t_assert_v2 sid-ambiguous-T94 transport.inject_id null

# ── E) the SAME id repeated is not ambiguous — record it ──
stub_inject "$OK_LINE" "   inject_id: $UUID" "   inject_id: $UUID"
run_case sid-repeat-T94
t_assert_v2 sid-repeat-T94 transport.inject_id "$UUID"

# ── F) an id printed before a FAILED inject is still recorded ──
# Bytes may have landed; the transport result is honestly `unknown`, and the id
# is exactly what lets the tracker poll the daemon to find out. Throwing it away
# here would strand the one dispatch that most needs observing.
cat > "$STUB_BIN/telepty" <<EOF
#!/usr/bin/env bash
case "\$1" in
  list) shift; [ "\${1:-}" = "--json" ] && cat "$STUB_LIST_FILE";;
  inject)
    printf 'telepty inject %s\n' "\$*" >> "$STUB_DISPATCH_LOG"
    echo "$OK_LINE"
    echo "   inject_id: $UUID"
    echo "submit failed" >&2
    exit 1;;
  *) echo "stub telepty \$*";;
esac
EOF
chmod +x "$STUB_BIN/telepty"
SID_F=sid-injectfail-T94
printf 'payload\n' > "$T_TMP/ref-$SID_F.md"
printf '%s' "[{\"id\":\"$SID_F\",\"command\":\"claude\",\"healthStatus\":\"CONNECTED\"}]" > "$STUB_LIST_FILE"
set +e
t_run_dispatch --target "$SID_F" --ref "$T_TMP/ref-$SID_F.md" --from orchestrator \
  --no-verify-started --no-task "test-fixture T94" >/dev/null 2>&1
rc=$?
set -e
[ "$rc" -eq 3 ] || fail "F: dispatch exit $rc, want 3 (inject failed)"
t_assert_v2 "$SID_F" transport.result unknown
t_assert_v2 "$SID_F" transport.inject_id "$UUID"
t_assert_outcome_unknown "$SID_F"

# ── G) telepty's own stdout must still reach the operator ──
# The id is scraped from a stream a human reads; capturing it must not silence
# the "✅ Context injected" line the operator relies on.
stub_inject "$OK_LINE" "   inject_id: $UUID"
printf 'payload\n' > "$T_TMP/ref-vis.md"
printf '%s' '[{"id":"sid-visible-T94","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
out=$(t_run_dispatch --target sid-visible-T94 --ref "$T_TMP/ref-vis.md" --from orchestrator \
        --no-verify-started --no-task "test-fixture T94" 2>/dev/null) || fail "G: dispatch failed"
printf '%s' "$out" | grep -qF "Context injected successfully" \
  || fail "G: telepty's inject output no longer reaches stdout: [$out]"

# ── H) capturing the id must never be able to FAIL a dispatch ──
# dispatch.sh's standing invariant is that nothing fallible runs between
# begin-delivery's durable commit and the transport call — a crash in that window
# is indistinguishable from a delivery whose bytes may have landed.
#
# #899 tranche 1: this case used to assert inject_id == null here. That null was
# an ACCIDENT of the bash implementation, not a contract. The shell tee'd
# telepty's stdout through `mktemp "${TMPDIR:-/tmp}/dispatch-inject.XXXXXX"`
# (dispatch.sh:372-388 pre-port); an unwritable TMPDIR made mktemp fail, so the
# scrape was skipped and the id was lost as a side effect of needing a scratch
# file. The contract is #872's — capture the inject_id telepty prints — and the
# TS port tees through an in-memory buffer, so it satisfies that even here.
# The invariant this case exists for is asserted below by rc == 0 and
# transport.result: an unwritable TMPDIR must not break a delivery the registry
# has already authorized. A scratch file is NOT to be reintroduced to reproduce
# the old null.
stub_inject "$OK_LINE" "   inject_id: $UUID"
NOWRITE="$T_TMP/unwritable"
mkdir -p "$NOWRITE"; chmod 0555 "$NOWRITE"
printf 'payload\n' > "$T_TMP/ref-nowrite.md"
printf '%s' '[{"id":"sid-nowrite-T94","command":"claude","healthStatus":"CONNECTED"}]' > "$STUB_LIST_FILE"
set +e
TMPDIR="$NOWRITE" t_run_dispatch --target sid-nowrite-T94 --ref "$T_TMP/ref-nowrite.md" \
  --from orchestrator --no-verify-started --no-task "test-fixture T94" >/dev/null 2>&1
rc=$?
set -e
chmod 0755 "$NOWRITE"
[ "$rc" -eq 0 ] || fail "H: an unwritable TMPDIR failed the dispatch (exit $rc) — id capture must degrade, not abort"
t_assert_v2 sid-nowrite-T94 transport.result write_observed
# …and the id survives it, because capturing it no longer depends on the
# filesystem at all. The tracker gets a real handle instead of the
# no_transport_inject_id HOLD that an unwritable TMPDIR used to force.
t_assert_v2 sid-nowrite-T94 transport.inject_id "$UUID"

echo "T94 PASS"
