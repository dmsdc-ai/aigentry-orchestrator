#!/usr/bin/env bash
# dispatch-prelude lint — ADR-MF #7 (F1)
# Scans a dispatch markdown file for required prelude/reporting markers.
# Exit 0 = pass, 1 = lint failure, 2 = usage/IO error.
set -euo pipefail

usage() {
  cat <<EOF
Usage: lint.sh [--quiet] [--warn-as-error] <dispatch-file>

Checks (errors → exit 1):
  E1  ROLE OVERRIDE section header present
  E2  anti-orchestrator clause present ("Do NOT assume orchestrator role" or "You are NOT orchestrator")
  E3  cwd = \`...\` declaration present in prelude
  E4  Reporting section present with ⚠️ MANDATORY marker
  E5  telepty inject template with --from <sid> + parent target

Warnings (warn-only unless --warn-as-error):
  W1  Article 17 / Article 1 reference absent
  W2  /using-superpowers reference absent
EOF
}

QUIET=0; WARN_FATAL=0; FILE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --quiet)          QUIET=1;       shift ;;
    --warn-as-error)  WARN_FATAL=1;  shift ;;
    -h|--help)        usage; exit 0 ;;
    -*) echo "lint.sh: unknown flag: $1" >&2; usage >&2; exit 2 ;;
    *) [ -n "$FILE" ] && { echo "lint.sh: only one file allowed" >&2; exit 2; }; FILE="$1"; shift ;;
  esac
done

[ -n "$FILE" ]  || { echo "lint.sh: missing <dispatch-file>" >&2; usage >&2; exit 2; }
[ -f "$FILE" ]  || { echo "lint.sh: not a file: $FILE" >&2; exit 2; }

errs=0; warns=0
report_dir="${TMPDIR:-/tmp}"
report="$(mktemp "$report_dir/dispatch-lint.XXXXXX")"
trap 'rm -f "$report"' EXIT

emit_err() {
  errs=$((errs + 1))
  printf '%s:%s: error %s: %s\n' "$FILE" "$2" "$1" "$3" >> "$report"
}
emit_warn() {
  warns=$((warns + 1))
  printf '%s:%s: warning %s: %s\n' "$FILE" "$2" "$1" "$3" >> "$report"
}

# Helper: find first line matching pattern (returns line number or 0).
firstline_re() {
  awk -v pat="$1" 'BEGIN{found=0} $0 ~ pat { print NR; found=1; exit } END { if (!found) print 0 }' "$FILE"
}

# E1 — ROLE OVERRIDE header
ln="$(firstline_re '^##[[:space:]]+.*ROLE OVERRIDE')"
[ "$ln" = "0" ] && emit_err E1 1 "missing '## ROLE OVERRIDE' section header"

# E2 — anti-orchestrator clause
if ! grep -qE 'Do NOT assume orchestrator role|You are NOT( the)? orchestrator' "$FILE"; then
  emit_err E2 "${ln:-1}" "missing anti-orchestrator clause ('Do NOT assume orchestrator role' or 'You are NOT (the) orchestrator')"
fi

# E3 — cwd = `...` declaration
cwd_ln="$(firstline_re '^-?[[:space:]]*cwd[[:space:]]*=[[:space:]]*`')"
[ "$cwd_ln" = "0" ] && emit_err E3 "${ln:-1}" "missing cwd declaration (e.g. '- cwd = \`/path\`')"

# E4 — Reporting section + ⚠️ MANDATORY marker
rep_ln="$(firstline_re '^##[[:space:]]+Reporting')"
if [ "$rep_ln" = "0" ]; then
  emit_err E4 1 "missing '## Reporting' section"
else
  if ! awk -v start="$rep_ln" 'NR>=start && /MANDATORY/ { found=1; exit } END { exit !found }' "$FILE"; then
    emit_err E4 "$rep_ln" "'## Reporting' present but missing 'MANDATORY' marker"
  fi
fi

# E5 — telepty inject template with --from + target
if ! grep -qE 'telepty inject[^\n]*--from[[:space:]]+[A-Za-z0-9_.-]+' "$FILE"; then
  emit_err E5 "${rep_ln:-1}" "missing 'telepty inject ... --from <sid>' template"
fi

# W1 — Article 17 / Article 1 reference
if ! grep -qE 'Article (1|17)' "$FILE"; then
  emit_warn W1 1 "no Article 1/17 reference (경량/무의존 context)"
fi

# W2 — /using-superpowers reference
if ! grep -qE '/using-superpowers' "$FILE"; then
  emit_warn W2 1 "no '/using-superpowers' reference in Full capability"
fi

if [ "$QUIET" = "0" ] && [ -s "$report" ]; then
  cat "$report"
fi

total_fail=$errs
[ "$WARN_FATAL" = "1" ] && total_fail=$((errs + warns))

if [ "$QUIET" = "0" ]; then
  echo "lint.sh: $FILE — errors=$errs warnings=$warns"
fi

[ "$total_fail" -eq 0 ] && exit 0 || exit 1
