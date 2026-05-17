#!/usr/bin/env bash
# snyk-scan.sh — invoke Snyk Code SAST on the current commit's changed files (or a range, or full repo).
# Background: docs/setup/snyk-mcp.md. Implements the global "Snyk Security At Inception" rule
# in shells / dispatched sessions where the MCP host is not available.
#
# Usage:
#   bin/snyk-scan.sh                 # changes in HEAD vs HEAD~1
#   bin/snyk-scan.sh HEAD~3..HEAD    # explicit git range
#   bin/snyk-scan.sh --all           # full repo
#   bin/snyk-scan.sh --help
#
# Exit codes:
#   0  no issues
#   1  issues found (snyk's native code)
#   2  CLI / setup error (snyk missing, not authed, etc.)
#
# Requires: snyk CLI on PATH, authenticated (`snyk auth` once).

set -euo pipefail

usage() {
  sed -n '2,18p' "$0"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if ! command -v snyk >/dev/null 2>&1; then
  echo "[snyk-scan] error: snyk CLI not found. Install: npm install -g snyk" >&2
  exit 2
fi

if [[ -z "${SNYK_TOKEN:-}" ]] \
   && ! snyk whoami >/dev/null 2>&1 \
   && [[ -z "$(snyk config get api 2>/dev/null)" ]]; then
  echo "[snyk-scan] error: Snyk not authenticated. Run: snyk auth (or set SNYK_TOKEN env var)" >&2
  exit 2
fi

if [[ "${1:-}" == "--all" ]]; then
  echo "[snyk-scan] scanning whole repo"
  exec snyk code test
fi

range="${1:-HEAD~1..HEAD}"

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  echo "[snyk-scan] error: not a git repo; pass --all or run inside a checkout" >&2
  exit 2
fi

mapfile -t changed < <(git diff --name-only --diff-filter=ACMR "$range" 2>/dev/null || true)

if [[ ${#changed[@]} -eq 0 ]]; then
  echo "[snyk-scan] no changed files in range $range — nothing to scan"
  exit 0
fi

echo "[snyk-scan] range=$range changed_files=${#changed[@]}"
printf '  %s\n' "${changed[@]}"

# Snyk Code scans by path, not file list. Compute the set of unique parent dirs
# of changed files (capped to repo root if any file is at root).
# Note: dirname returns "." for files at the repo root; we keep "." as the
# sentinel because bash associative arrays reject the empty string as a key.
declare -A dir_set=()
for f in "${changed[@]}"; do
  d="$(dirname "$f")"
  dir_set["$d"]=1
done

# If repo root is in the set, just scan once at root.
if [[ -n "${dir_set["."]:-}" ]]; then
  echo "[snyk-scan] root-level changes — scanning whole repo"
  exec snyk code test
fi

rc=0
for d in "${!dir_set[@]}"; do
  echo
  echo "[snyk-scan] >>> snyk code test $d"
  snyk code test "$d" || rc=$?
done
exit "$rc"
