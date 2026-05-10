#!/usr/bin/env bash
# Orchestrate Q1 batch: 4 volumes × 3 seeds, sequential.
# Assumes V4 probe (separate invocation) has already validated -p mode triggers compact.
#
# Usage: run_all.sh
# Env:
#   ISOHOME    isolated HOME (default /tmp/q1-claude-test-home)
#   SKIP_V4_S42  set to 1 to skip the V4-s42 run (already executed as probe)

set -euo pipefail

BIN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RESEARCH_DIR="$(cd "$BIN_DIR/.." && pwd)"
RAW_DIR="$RESEARCH_DIR/raw"
CSV="$RESEARCH_DIR/runs.csv"
mkdir -p "$RAW_DIR"

export ISOHOME="${ISOHOME:-/tmp/q1-claude-test-home}"
SKIP_V4_S42="${SKIP_V4_S42:-0}"

# Hard wall-time cap: 3h (R2 refinement).
DEADLINE=$(( $(date +%s) + 3 * 60 * 60 ))

# CSV header.
HOME="$ISOHOME" python3 "$BIN_DIR/parse_run.py" __header__ 0 0 /dev/null --header > "$CSV" 2>/dev/null \
  || echo "run_id,seed,volume_target_tokens,turn_idx,total_input_tokens,cache_create,cache_read,output_tokens,auto_compact_fired" > "$CSV"

# Iterate volume × seed sequentially.
AUTH_FAILS=0
for VOLUME in V1 V2 V3 V4; do
  for SEED in 42 43 44; do
    RUN_ID="${VOLUME}-s${SEED}"
    if [[ "$SKIP_V4_S42" == "1" && "$VOLUME" == "V4" && "$SEED" == "42" ]]; then
      # Reuse probe artifact: stitch its CSV rows in.
      PROBE_CSV="$RAW_DIR/probe_V4_s42.csv"
      if [[ -f "$PROBE_CSV" ]]; then
        cat "$PROBE_CSV" >> "$CSV"
        echo "[orch] $RUN_ID skipped (probe artifact reused)" >&2
      else
        echo "[orch] WARN: SKIP_V4_S42 set but $PROBE_CSV missing" >&2
      fi
      continue
    fi

    if (( $(date +%s) > DEADLINE )); then
      echo "[orch] FATAL: 3h hard cap exceeded — aborting batch with partial CSV" >&2
      exit 4
    fi

    if (( AUTH_FAILS >= 3 )); then
      echo "[orch] FATAL: 3 consecutive auth failures — aborting (STUCK)" >&2
      exit 5
    fi

    LOG="$RAW_DIR/run_${RUN_ID}.log"
    PARSED="$RAW_DIR/run_${RUN_ID}.csv"
    echo "[orch] starting $RUN_ID" >&2
    if "$BIN_DIR/one_run.sh" "$VOLUME" "$SEED" 30 300000 "$RAW_DIR" \
         > "$PARSED" 2> "$LOG"; then
      cat "$PARSED" >> "$CSV"
      AUTH_FAILS=0
    else
      EC=$?
      echo "[orch] $RUN_ID failed exit=$EC — see $LOG" >&2
      if grep -q "Not logged in\|401\|auth" "$LOG" 2>/dev/null; then
        AUTH_FAILS=$(( AUTH_FAILS + 1 ))
      fi
      # Stitch any partial rows so we don't lose the run.
      [[ -s "$PARSED" ]] && cat "$PARSED" >> "$CSV"
    fi
    sleep 30  # rate-limit cushion
  done
done

echo "[orch] batch complete — $CSV" >&2
wc -l "$CSV" >&2
