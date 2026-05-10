#!/usr/bin/env python3
"""Deterministic prompt generator for Q1 threshold runs.

Usage: gen_prompt.py <volume> <seed> <turn_idx>
  volume ∈ {V1,V2,V3,V4} (10k/50k/100k/180k target tokens per turn)
"""
import sys

PARA = (
    "The instrumented harness measures Claude Code auto-compact threshold by emitting deterministic "
    "payloads of bounded size and observing usage growth across turns. Each paragraph is roughly five "
    "hundred tokens long when tokenized by the production tokenizer, which means we can scale the per-"
    "turn input volume by simple paragraph repetition. The harness itself is intentionally trivial: a "
    "deterministic seed selects a counter base, the counter increments per turn, and the suffix carries "
    "the counter so that the prompt prefix is reproducible while the tail bytes change to defeat any "
    "trivial cache-collapse optimization. Empirical measurement is the goal, not implementation novelty. "
    "We expect the auto-compact event to surface as either an isCompactSummary user record in the parent "
    "session jsonl or a sibling subagents/agent-acompact-* directory, depending on the Claude Code version. "
    "Either marker is sufficient to declare the firing turn. Cumulative input tokens are the sum of the "
    "input_tokens, cache_creation_input_tokens, and cache_read_input_tokens fields on the assistant turn. "
    "These numbers are reported per-turn and accumulated by the analyst downstream. Determinism matters "
    "because we need to replicate runs across seeds and across machines, and the prompt content must be "
    "identical given the same seed and turn index. The paragraph repetition is the dominant lever. "
)

R_BY_VOLUME = {"V1": 30, "V2": 150, "V3": 300, "V4": 540}
TARGET_BY_VOLUME = {"V1": 10_000, "V2": 50_000, "V3": 100_000, "V4": 180_000}


def build(volume: str, seed: int, turn_idx: int) -> str:
    R = R_BY_VOLUME[volume]
    counter = turn_idx * 100003 + seed
    body = PARA * R
    return (
        f"You are a measurement harness target. Reply with EXACTLY: \"ack {turn_idx}\".\n"
        f"Do not call any tools. Do not elaborate.\n\n"
        f"{body}\n"
        f"--- TURN {turn_idx} SEED {seed} VOLUME {volume} COUNTER {counter} ---\n"
    )


if __name__ == "__main__":
    if len(sys.argv) != 4:
        print("usage: gen_prompt.py <volume> <seed> <turn_idx>", file=sys.stderr)
        sys.exit(2)
    volume, seed, turn_idx = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    if volume not in R_BY_VOLUME:
        print(f"unknown volume {volume}", file=sys.stderr)
        sys.exit(2)
    sys.stdout.write(build(volume, seed, turn_idx))
