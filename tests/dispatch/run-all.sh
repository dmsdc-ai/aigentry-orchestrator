#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd -P)"
chmod +x "$HERE"/T*.sh "$HERE"/stubs/* 2>/dev/null || true
pass=0; fail=0; failed=""
for t in "$HERE"/T*.sh; do
  name=$(basename "$t")
  if bash "$t"; then pass=$((pass+1));
  else fail=$((fail+1)); failed="$failed $name"; fi
done
echo "----"
echo "passed: $pass  failed: $fail"
[ "$fail" = "0" ] || { echo "failed:$failed"; exit 1; }
