#!/usr/bin/env bash
# T67 — #690 / Rule 16: the worker→orchestrator REPORT target is the RESOLVED
# orchestrator address, never the phantom `aigentry-orchestrator-claude`.
#   1. resolver: env override (sid+host) wins.
#   2. resolver: sid-only override → bare <sid> or <sid>@<ip>, never phantom.
#   3. dispatch.sh prepare_effective_ref() substitutes {{ORCHESTRATOR_REPORT_TARGET}}
#      in the injected ref with the resolved target.
#   4. ref without the placeholder → passthrough unchanged (back-compat).
#   5. resolver missing / failing / empty → FAILS CLOSED: non-zero, and NOTHING is
#      injected. An unresolved target must never be substituted as the empty
#      string and reported as success — #690 reborn.
#
# telepty#60 Stage A moved this substitution out of do_inject and in front of the
# begin-delivery commit: no fallible preparation may run between the durable
# record and the transport call. The #690 property is unchanged and now fails
# even earlier — before a dispatch record exists at all.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

RESOLVER="$REPO_ROOT/bin/orchestrator-report-target.sh"

# The resolver now probes a candidate address before returning the `<sid>@<ip>`
# form (#835 — it used to infer reachability from an interface having an address).
# Pin that probe to a stub so this test stays hermetic and fast: otherwise case 1
# dials a black-holed address for its connect timeout, and case 2 depends on
# whether this machine's real tailnet listener happens to be up. Reachability
# itself is T92's subject; this file is about WHICH address is chosen.
CURL_OK="$T_TMP/curl-answers"
printf '%s\n' '#!/usr/bin/env bash' 'echo 200' > "$CURL_OK"
chmod +x "$CURL_OK"
export CURL="$CURL_OK"

# ---- 1. resolver: env override wins (sid + host) ----
out=$(AIGENTRY_ORCHESTRATOR_SID=orch-x AIGENTRY_ORCHESTRATOR_HOST=100.99.1.2 "$RESOLVER")
[ "$out" = "orch-x@100.99.1.2" ] || { echo "FAIL: override resolver = '$out'" >&2; exit 1; }

# ---- 2. resolver: sid-only override → bare or <sid>@<ip>, never phantom ----
out=$(AIGENTRY_ORCHESTRATOR_SID=orch-y "$RESOLVER")
case "$out" in
  orch-y|orch-y@*) : ;;
  *) echo "FAIL: sid-override resolver = '$out'" >&2; exit 1;;
esac
if printf '%s' "$out" | grep -qF 'aigentry-orchestrator-claude'; then
  echo "FAIL: phantom sid in resolver output: $out" >&2; exit 1
fi

# ---- 3. do_inject() substitutes the placeholder ----
cap="$T_TMP/injected-ref.txt"; : > "$cap"
export CAP_FILE="$cap"
cnt="$T_TMP/inject-count"; echo 0 > "$cnt"
export CNT_FILE="$cnt"

mystub="$T_TMP/telepty-capture"
cat > "$mystub" <<'STUB'
#!/usr/bin/env bash
# capture the CONTENT of the --ref file actually injected (do_inject deletes its
# temp copy after inject, so we must read it here, during the call) and count the
# injects, so case 5 can assert that a failed resolve injected NOTHING at all.
if [ "$1" = "inject" ]; then
  echo $(( $(cat "$CNT_FILE") + 1 )) > "$CNT_FILE"
  prev=""
  for a in "$@"; do [ "$prev" = "--ref" ] && cat "$a" > "$CAP_FILE"; prev="$a"; done
  echo "stub inject OK"; exit 0
fi
echo "stub telepty $*"
STUB
chmod +x "$mystub"

myresolver="$T_TMP/resolver-stub"
printf '#!/usr/bin/env bash\necho "orchestrator@100.72.155.21"\n' > "$myresolver"
chmod +x "$myresolver"

ref="$T_TMP/ref.md"
printf 'task body\ntelepty inject --from {sid} {{ORCHESTRATOR_REPORT_TARGET}} "REPORT: ..."\n' > "$ref"

export DISPATCH_SH_NO_MAIN=1
export TELEPTY="$mystub"
export REPORT_TARGET_SH="$myresolver"
# shellcheck source=/dev/null
source "$REPO_ROOT/bin/dispatch.sh"
ref_file="$ref"; from_id="orchestrator"
prepare_effective_ref
do_inject sid-A >/dev/null

t_assert_contains "$cap" 'orchestrator@100.72.155.21'
if grep -qF '{{ORCHESTRATOR_REPORT_TARGET}}' "$cap"; then
  echo "FAIL: placeholder not substituted" >&2; cat "$cap" >&2; exit 1
fi
if grep -qF 'aigentry-orchestrator-claude' "$cap"; then
  echo "FAIL: phantom sid was injected" >&2; exit 1
fi

# ---- 4. no placeholder → passthrough unchanged ----
: > "$cap"
ref2="$T_TMP/ref2.md"
printf 'plain body no placeholder\n' > "$ref2"
ref_file="$ref2"
prepare_effective_ref
do_inject sid-A >/dev/null
t_assert_contains "$cap" 'plain body no placeholder'

# ---- 5. resolver missing / failing / empty → fail closed, inject NOTHING ----
# Asserted through the real call site's shape (`prepare_effective_ref || exit 3`),
# which runs with errexit disabled inside the function body — the reason this
# needs an explicit guard.
failing_empty="$T_TMP/resolver-empty"
printf '#!/usr/bin/env bash\nexit 0\n' > "$failing_empty"   # rc 0 but no output
chmod +x "$failing_empty"

for bad in "$T_TMP/resolver-does-not-exist" "$failing_empty"; do
  : > "$cap"; echo 0 > "$cnt"
  ref_file="$ref"                       # the ref that DOES carry the placeholder
  REPORT_TARGET_SH="$bad"
  rc=0
  if ! prepare_effective_ref >/dev/null 2>&1; then rc=1; fi
  [ "$rc" -ne 0 ] || {
    echo "FAIL: prepare_effective_ref returned 0 with an unresolvable target ($bad)" >&2
    echo "      injected: [$(cat "$cap")]" >&2; exit 1; }
  [ "$(cat "$cnt")" = "0" ] || {
    echo "FAIL: injected $(cat "$cnt")x despite an unresolvable target ($bad)" >&2
    echo "      injected: [$(cat "$cap")]" >&2; exit 1; }
done

echo "T67 PASS"
