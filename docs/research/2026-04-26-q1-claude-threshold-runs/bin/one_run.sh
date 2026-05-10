#!/usr/bin/env bash
# Single Q1 run: drive claude --resume -p loop, ≤30 turns or until compact / cumulative cap.
#
# Usage: one_run.sh <volume V1|V2|V3|V4> <seed> <max_turns> <cum_input_cap_tokens> <out_dir>
#   out_dir   directory to copy the resulting jsonl into (raw/)
#
# Env:
#   ISOHOME    isolated HOME (must start with /tmp/q1-claude-test-home)  REQUIRED
#   PROBE      "1" → also stop when cumulative input > cum_input_cap_tokens (R1 probe)

set -euo pipefail

VOLUME="${1:?volume}"; SEED="${2:?seed}"; MAX_TURNS="${3:-30}"; CUM_CAP="${4:-300000}"; OUT_DIR="${5:?out_dir}"
PROBE="${PROBE:-0}"

if [[ -z "${ISOHOME:-}" || "$ISOHOME" != /tmp/q1-claude-test-home* ]]; then
  echo "FATAL: ISOHOME must be set and under /tmp/q1-claude-test-home" >&2
  exit 2
fi

# Refresh credentials from macOS keychain into isolated HOME (auth-token TTL mitigation).
mkdir -p "$ISOHOME/.claude"
if security find-generic-password -a "$USER" -s "Claude Code-credentials" -w >"$ISOHOME/.claude/.credentials.json" 2>/dev/null; then
  chmod 600 "$ISOHOME/.claude/.credentials.json"
else
  echo "[run] WARN: could not refresh credentials from keychain (continuing with stale)" >&2
fi
if ! HOME="$ISOHOME" claude --version >/dev/null 2>&1; then
  echo "FATAL: claude --version failed under isolated HOME" >&2
  exit 3
fi

BIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$ISOHOME/work"
mkdir -p "$WORK_DIR" "$OUT_DIR"

# Pre-assigned UUID for predictable jsonl filename.
SESSION_ID="$(uuidgen | tr 'A-Z' 'a-z')"
RUN_ID="${VOLUME}-s${SEED}"
echo "[run] $RUN_ID session=$SESSION_ID volume=$VOLUME seed=$SEED max_turns=$MAX_TURNS cap=$CUM_CAP probe=$PROBE" >&2

# Encoded cwd → claude projects dir (replace / with -).
ENC_CWD="$(echo "$WORK_DIR" | tr '/' '-')"
PROJ_DIR="$ISOHOME/.claude/projects/${ENC_CWD}"
JSONL="$PROJ_DIR/${SESSION_ID}.jsonl"

CUM_IN=0
COMPACT_FIRED=0
LAST_TURN=0

for ((TURN=1; TURN<=MAX_TURNS; TURN++)); do
  PROMPT="$(HOME="$ISOHOME" python3 "$BIN_DIR/gen_prompt.py" "$VOLUME" "$SEED" "$TURN")"
  TURN_T0=$(date +%s)
  if (( TURN == 1 )); then
    (cd "$WORK_DIR" && HOME="$ISOHOME" claude --session-id "$SESSION_ID" \
      --dangerously-skip-permissions \
      -p "$PROMPT" --output-format json) > /tmp/q1-turn-${RUN_ID}-${TURN}.json 2>&1 || {
        echo "[run] turn $TURN claude exit non-zero — see /tmp/q1-turn-${RUN_ID}-${TURN}.json" >&2
        break
      }
  else
    (cd "$WORK_DIR" && HOME="$ISOHOME" claude --resume "$SESSION_ID" \
      --dangerously-skip-permissions \
      -p "$PROMPT" --output-format json) > /tmp/q1-turn-${RUN_ID}-${TURN}.json 2>&1 || {
        echo "[run] turn $TURN resume claude exit non-zero — see /tmp/q1-turn-${RUN_ID}-${TURN}.json" >&2
        break
      }
  fi
  TURN_DT=$(( $(date +%s) - TURN_T0 ))

  # Locate jsonl (path may use a slightly different encoding on first turn).
  if [[ ! -f "$JSONL" ]]; then
    JSONL="$(ls "$ISOHOME/.claude/projects/"*"/${SESSION_ID}.jsonl" 2>/dev/null | head -1 || true)"
  fi
  if [[ -z "${JSONL:-}" || ! -f "$JSONL" ]]; then
    echo "[run] turn $TURN: cannot find session jsonl after invocation. Aborting." >&2
    break
  fi

  # Pull the most recent assistant usage row (Python one-liner).
  read -r LAST_TOTAL LAST_CC LAST_CR LAST_OUT FIRED < <(HOME="$ISOHOME" python3 - "$JSONL" <<'PY'
import json, sys
fn = sys.argv[1]
last = (0,0,0,0)
fired = 0
for line in open(fn, errors='ignore'):
    line=line.strip()
    if not line: continue
    try: d=json.loads(line)
    except Exception: continue
    if d.get('isCompactSummary') is True:
        fired = 1
    if d.get('type')=='assistant':
        u=(d.get('message') or {}).get('usage') or {}
        inp=int(u.get('input_tokens',0) or 0)
        cc=int(u.get('cache_creation_input_tokens',0) or 0)
        cr=int(u.get('cache_read_input_tokens',0) or 0)
        out=int(u.get('output_tokens',0) or 0)
        last=(inp+cc+cr, cc, cr, out)
import os, glob
sub_glob = os.path.join(fn[:-6], 'subagents', 'agent-acompact-*.jsonl')
if glob.glob(sub_glob): fired = 1
print(last[0], last[1], last[2], last[3], fired)
PY
)
  CUM_IN=$(( CUM_IN + LAST_TOTAL ))
  LAST_TURN=$TURN
  echo "[run] $RUN_ID t=$TURN in=$LAST_TOTAL cc=$LAST_CC cr=$LAST_CR out=$LAST_OUT cum=$CUM_IN dt=${TURN_DT}s fired=$FIRED" >&2

  if [[ "$FIRED" == "1" ]]; then
    COMPACT_FIRED=1
    break
  fi
  if [[ "$PROBE" == "1" && $CUM_IN -gt $CUM_CAP ]]; then
    echo "[run] PROBE cap reached: cum=$CUM_IN > $CUM_CAP — stopping" >&2
    break
  fi
done

# Copy raw jsonl into out_dir.
DEST="$OUT_DIR/run_${RUN_ID}.jsonl"
if [[ -f "${JSONL:-}" ]]; then
  cp "$JSONL" "$DEST"
fi

# Emit per-run CSV rows (no header — caller composes runs.csv).
HOME="$ISOHOME" python3 "$BIN_DIR/parse_run.py" "$RUN_ID" "$SEED" \
  "$(python3 -c "print({'V1':10000,'V2':50000,'V3':100000,'V4':180000}['$VOLUME'])")" \
  "$DEST"

# Summary line on stderr for harness consumption.
echo "[run] DONE $RUN_ID turns=$LAST_TURN cum_in=$CUM_IN compact=$COMPACT_FIRED jsonl=$DEST" >&2
