#!/usr/bin/env bash
# dispatch-prelude generator — ADR-MF #7 (F1)
# Substitutes session metadata into the canonical dispatch template.
# POSIX-compatible bash, no external deps beyond coreutils.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${DISPATCH_PRELUDE_TEMPLATE:-$SCRIPT_DIR/template.md}"

ROLE_ENUM="orchestrator architect coder implementer tester builder analyst researcher reviewer grader logger security-reviewer"

usage() {
  cat <<EOF
Usage: generator.sh --role <r> --task <t> --cwd <path> --parent <sid> [--session <sid>] [--parent-role <r>] [--task-name <n>] [--report-tag <tag>] [--out <file>]

Required:
  --role <r>          Session role (one of: $ROLE_ENUM)
  --task <t>          Task description (single-line summary; multi-line via stdin: pass '-')
  --cwd <path>        Absolute cwd path (tmpdir or repo cwd per ADR §4.5)
  --parent <sid>      Parent session id (e.g. 'orchestrator')

Optional:
  --session <sid>     Session id (default: E-<role>-<epoch-tail>)
  --parent-role <r>   Parent role (default: 'orchestrator')
  --task-name <n>     One-line task name in title (default: first 60 chars of --task)
  --report-tag <tag>  REPORT/STUCK tag in reporting section (default: <SESSION-UPPER>_DONE)
  --out <file>        Write to file (default: stdout)
  -h, --help          Show this help
EOF
}

ROLE=""; TASK=""; CWD=""; PARENT=""; SESSION=""; PARENT_ROLE="orchestrator"; TASK_NAME=""; REPORT_TAG=""; OUT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --role)         ROLE="${2:-}";        shift 2 ;;
    --task)         TASK="${2:-}";        shift 2 ;;
    --cwd)          CWD="${2:-}";         shift 2 ;;
    --parent)       PARENT="${2:-}";      shift 2 ;;
    --session)      SESSION="${2:-}";     shift 2 ;;
    --parent-role)  PARENT_ROLE="${2:-}"; shift 2 ;;
    --task-name)    TASK_NAME="${2:-}";   shift 2 ;;
    --report-tag)   REPORT_TAG="${2:-}";  shift 2 ;;
    --out)          OUT="${2:-}";         shift 2 ;;
    -h|--help)      usage; exit 0 ;;
    *) echo "generator.sh: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

err() { echo "generator.sh: $*" >&2; exit 2; }

[ -n "$ROLE" ]   || err "missing --role"
[ -n "$TASK" ]   || err "missing --task"
[ -n "$CWD" ]    || err "missing --cwd"
[ -n "$PARENT" ] || err "missing --parent"

[ -f "$TEMPLATE" ] || err "template not found: $TEMPLATE"

# Role enum check
role_ok=0
for r in $ROLE_ENUM; do [ "$r" = "$ROLE" ] && role_ok=1 && break; done
[ "$role_ok" = "1" ] || err "unknown role '$ROLE' (allowed: $ROLE_ENUM)"

# cwd must be absolute (ADR §4.5: absolute paths)
case "$CWD" in /*) ;; *) err "--cwd must be absolute path, got: $CWD" ;; esac

# Read task from stdin if requested
if [ "$TASK" = "-" ]; then
  TASK="$(cat)"
  [ -n "$TASK" ] || err "--task '-' read empty body from stdin"
fi

# Defaults
if [ -z "$SESSION" ]; then
  tail="$(date +%s | tail -c 5)"
  SESSION="E-${ROLE}-${tail}"
fi
if [ -z "$TASK_NAME" ]; then
  first_line="$(printf '%s' "$TASK" | awk 'NR==1{print; exit}')"
  TASK_NAME="$(printf '%s' "$first_line" | cut -c1-60)"
fi
if [ -z "$REPORT_TAG" ]; then
  upper="$(printf '%s' "$SESSION" | tr '[:lower:]-' '[:upper:]_')"
  REPORT_TAG="${upper}_DONE"
fi

# Substitution (POSIX awk — safe for paths containing /, &, slashes).
subst() {
  awk -v s="$SESSION" -v r="$ROLE" -v p="$PARENT" -v pr="$PARENT_ROLE" \
      -v c="$CWD" -v t="$TASK" -v tn="$TASK_NAME" -v rt="$REPORT_TAG" '
    {
      gsub(/\{\{SESSION_ID\}\}/, s)
      gsub(/\{\{ROLE\}\}/, r)
      gsub(/\{\{PARENT_SID\}\}/, p)
      gsub(/\{\{PARENT_ROLE\}\}/, pr)
      gsub(/\{\{CWD\}\}/, c)
      gsub(/\{\{TASK_DESCRIPTION\}\}/, t)
      gsub(/\{\{TASK_NAME\}\}/, tn)
      gsub(/\{\{REPORT_TAG\}\}/, rt)
      print
    }
  ' "$TEMPLATE"
}

if [ -n "$OUT" ]; then
  out_dir="$(dirname -- "$OUT")"
  [ -d "$out_dir" ] || err "output dir does not exist: $out_dir"
  subst > "$OUT"
  echo "generator.sh: wrote $OUT" >&2
else
  subst
fi
