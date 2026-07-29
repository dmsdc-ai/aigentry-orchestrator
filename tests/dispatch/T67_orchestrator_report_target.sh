#!/usr/bin/env bash
# T67 — #690 / Rule 16: the worker→orchestrator REPORT target is the RESOLVED
# orchestrator address, never the phantom `aigentry-orchestrator-claude`.
#   1. resolver: env override (sid+host) wins.
#   2. resolver: sid-only override → bare <sid> or <sid>@<ip>, never phantom.
#   3. dispatch.sh do_inject() substitutes {{ORCHESTRATOR_REPORT_TARGET}} in the
#      injected ref with the resolved target.
#   4. ref without the placeholder → passthrough unchanged (back-compat).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
source "$HERE/lib.sh"
t_setup; trap t_teardown EXIT

RESOLVER="$REPO_ROOT/bin/orchestrator-report-target.sh"

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

mystub="$T_TMP/telepty-capture"
cat > "$mystub" <<'STUB'
#!/usr/bin/env bash
# capture the CONTENT of the --ref file actually injected (do_inject deletes its
# temp copy after inject, so we must read it here, during the call).
if [ "$1" = "inject" ]; then
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
do_inject sid-A >/dev/null
t_assert_contains "$cap" 'plain body no placeholder'

echo "T67 PASS"
