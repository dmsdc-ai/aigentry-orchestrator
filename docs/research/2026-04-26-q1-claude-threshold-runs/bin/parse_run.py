#!/usr/bin/env python3
"""Parse one Q1 run jsonl into CSV rows.

Usage: parse_run.py <run_id> <seed> <volume_target_tokens> <session_jsonl> [--header]

Emits CSV rows on stdout. Auto-compact detection:
  - any record in the jsonl with isCompactSummary=true, OR
  - a sibling subagents/agent-acompact-*.jsonl exists alongside the session jsonl.
"""
import csv, json, os, sys, glob

HEADER = [
    "run_id", "seed", "volume_target_tokens", "turn_idx",
    "total_input_tokens", "cache_create", "cache_read", "output_tokens",
    "auto_compact_fired",
]


def parse(jsonl_path: str):
    """Yield (turn_idx, total_in, cache_create, cache_read, output, fired)."""
    fired = False
    fired_turn = None
    turn_idx = 0
    rows = []
    with open(jsonl_path, "r", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except Exception:
                continue
            if d.get("isCompactSummary") is True:
                fired = True
                fired_turn = max(turn_idx, 1)
                continue
            if d.get("type") == "assistant":
                msg = d.get("message", {}) or {}
                u = msg.get("usage", {}) or {}
                turn_idx += 1
                inp = int(u.get("input_tokens", 0) or 0)
                cc = int(u.get("cache_creation_input_tokens", 0) or 0)
                cr = int(u.get("cache_read_input_tokens", 0) or 0)
                out = int(u.get("output_tokens", 0) or 0)
                total_in = inp + cc + cr
                rows.append([turn_idx, total_in, cc, cr, out])
    # filesystem-side compact detection (subagents/agent-acompact-*.jsonl)
    sess_dir = jsonl_path.removesuffix(".jsonl")
    sub_glob = os.path.join(sess_dir, "subagents", "agent-acompact-*.jsonl")
    if glob.glob(sub_glob):
        fired = True
        fired_turn = fired_turn or len(rows)
    return rows, fired, fired_turn


def main():
    args = sys.argv[1:]
    header = False
    if "--header" in args:
        header = True
        args.remove("--header")
    if len(args) != 4:
        print("usage: parse_run.py <run_id> <seed> <volume_target_tokens> <jsonl> [--header]", file=sys.stderr)
        sys.exit(2)
    run_id, seed, vol, jsonl = args
    rows, fired, fired_turn = parse(jsonl)
    w = csv.writer(sys.stdout)
    if header:
        w.writerow(HEADER)
    for (t, total_in, cc, cr, out) in rows:
        flag = "true" if (fired and fired_turn is not None and t >= fired_turn) else "false"
        w.writerow([run_id, seed, vol, t, total_in, cc, cr, out, flag])


if __name__ == "__main__":
    main()
