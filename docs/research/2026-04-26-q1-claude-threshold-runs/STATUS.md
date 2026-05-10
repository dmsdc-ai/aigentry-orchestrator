---
session: Q1-builder-instrument
parent_task: T2
status: ABORTED (methodology escalated to architect: Q1-architect-redesign)
date: 2026-04-26
claude_cli: 2.1.114
---

# T2 Status — V4 probe decisive, batch aborted

## Outcome
T2 was aborted by orchestrator after the V4 seed=42 probe returned a decisive negative result. Remaining 11 runs were not executed; `script(1)` fallback was not attempted. Methodology question (how to instrumentally trigger Claude Code auto-compact) escalated to architect session `Q1-architect-redesign`.

## What was completed
- Sub-spec authored, approved with R1/R2 refinements.
- Isolated HOME setup verified (`/tmp/q1-claude-test-home`, chmod-600 keychain credential copy).
- Harness implemented (`bin/gen_prompt.py`, `bin/parse_run.py`, `bin/one_run.sh`, `bin/run_all.sh`).
- V4 seed=42 probe executed.

## Probe finding (raw)
| Turn | input_tokens (total) | cache_create | cache_read | output | cumulative | compact_marker |
|---|---|---|---|---|---|---|
| 1 | 259,417 | 243,207 | 16,204 | 8 | 259,417 | absent |
| 2 | 494,411 | 234,994 | 259,411 | 8 | 753,828 | absent |

Stop reason: PROBE cumulative cap (>300k) per R1 refinement. Auto-compact marker (`isCompactSummary:true` record OR `subagents/agent-acompact-*` directory) was not present at the time of stop.

## Preserved artifacts (do not delete)
- `raw/probe_V4_s42.csv` — 2 CSV rows (matches schema).
- `raw/probe_V4_s42.log` — driver log with per-turn telemetry.
- `raw/run_V4-s42.jsonl` — 17-line raw session jsonl.
- `bin/` — full harness (idempotent; rerunnable if methodology changes).
- `SUB-SPEC.md` — original sub-spec as approved.

## Open methodology question (for architect)
Confirmed: `claude --resume -p` chains accumulate context across turns (turn-2 `cache_read=259,411` proves history replay) but auto-compact never fires in `-p` mode even past 750k cumulative input tokens. Therefore Q1 cannot be measured with non-interactive `-p` driver. Possible next-step instruments include `script(1)` PTY wrapper, `expect`-driven REPL, or `claude --output-format stream-json --input-format stream-json` interactive over stdin/stdout — all carry their own determinism risks. Architect to choose.

## What this session did NOT do (out of scope)
- Did not analyse or interpret the probe data beyond stating absence of marker.
- Did not modify Phase 3 archive.
- Did not invoke Codex/Gemini.
- Did not write a `runs.csv` (only the 2-row probe CSV exists).
