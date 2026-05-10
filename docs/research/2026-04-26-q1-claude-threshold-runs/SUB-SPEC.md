---
session: Q1-builder-instrument
parent_task: T2 (Q1 Claude auto-compact threshold measurement)
mode: SPEC FIRST (Rule 24)
status: AWAITING APPROVAL
authored: 2026-04-26
claude_cli: 2.1.114
---

# Q1 Sub-Spec — Instrumented Claude Auto-Compact Threshold Runs

## 1. Run matrix
4 volumes × 3 seeds = **12 runs**.

| Volume | `volume_target_tokens` | Per-turn payload size | Expected turn-to-fire (rough) |
|---|---|---|---|
| V1 | 10,000  | ~3.3 KB / turn | likely never fires (control) |
| V2 | 50,000  | ~16 KB / turn  | mid-range |
| V3 | 100,000 | ~33 KB / turn  | upper-mid |
| V4 | 180,000 | ~60 KB / turn  | should fire early |

Seeds: `42, 43, 44` (deterministic).
Stop condition (per run): **first** of (a) `isCompactSummary` marker observed, or (b) turn 30 reached.

## 2. Isolated HOME setup
```bash
ISOHOME=/tmp/q1-claude-test-home
rm -rf "$ISOHOME"
mkdir -p "$ISOHOME"
cp ~/.claude.json "$ISOHOME/.claude.json"          # real auth, not symlink
chmod 600 "$ISOHOME/.claude.json"
mkdir -p "$ISOHOME/.claude/projects"               # session jsonl will land here
export HOME="$ISOHOME"
```
All `claude` invocations run under this `HOME`. Real `~/.claude/` is never touched.

## 3. Deterministic prompt template
A single fixed paragraph (Lorem-Ipsum-style, ~330 words ≈ 500 tokens) is repeated `R` times then suffixed with `--- TURN <N> SEED <S> COUNTER <K> ---` to keep content unique per turn (prevents cache collapse). `R` is sized per volume:

- V1: R=20 → ~10k tok/turn cumulative payload by turn 1
- V2: R=100 → ~50k tok/turn cumulative
- V3: R=200 → ~100k tok/turn cumulative
- V4: R=360 → ~180k tok/turn cumulative

Per-turn user prompt template:
```
You are a measurement harness target. Reply with EXACTLY: "ack <turn>".
Do not call any tools. Do not elaborate.

<paragraph repeated R times>
--- TURN <N> SEED <S> COUNTER <K> ---
```
Counter `K = turn_idx * 100003 + seed` (deterministic, prime-step).

## 4. Driver: `claude --resume -p` chain
- Turn 1: `HOME=$ISOHOME claude -p "<prompt-1>" --output-format stream-json --include-partial-messages > /dev/null`
  - Captures the new session ID from the jsonl that lands in `$ISOHOME/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.
- Turn N (N≥2): `claude --resume <session-id> -p "<prompt-N>" --output-format stream-json > /dev/null`
- All runs use the SAME isolated `cwd` (`$ISOHOME/work`) so jsonls collect under one project dir.

**Open question (flag for orchestrator):** auto-compact may only fire in interactive REPL, not `-p` mode. If empirical check on V4 turn 1 shows no compact marker even past 200k input tokens, fallback driver = pseudo-tty wrapper using `script(1)` + stdin pipe of prompts separated by `\n` after waiting for prompt-ready marker. Decision deferred until first probe run.

## 5. Per-turn capture
After each `claude` invocation returns:
1. Read the newest jsonl under `$ISOHOME/.claude/projects/<encoded-cwd>/`.
2. Walk records; for the **last** `type:assistant` record, extract `message.usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}`.
3. Detect compact: scan for any `subagents/agent-acompact-*.jsonl` file under the session dir, OR any record with `isCompactSummary: true`. Mark `auto_compact_fired=true` for the turn where this **first** appears.
4. Append a row to `runs.csv`.

Parser is a single Python script `bin/parse_run.py` (~80 LOC, stdlib only).

## 6. Output layout
```
docs/research/2026-04-26-q1-claude-threshold-runs/
├── README.md             # run setup, prompts, isolated HOME, parser CLI usage
├── SUB-SPEC.md           # this file
├── bin/
│   ├── run_all.sh        # orchestrates 12 runs sequentially
│   ├── one_run.sh        # single run: volume + seed → jsonl + csv rows
│   └── parse_run.py      # jsonl → csv rows
├── runs.csv              # final aggregated CSV (12 runs × ≤30 turns)
└── raw/
    └── run_<volume>_<seed>.jsonl
```

`runs.csv` schema (matches T2 deliverable):
```
run_id,seed,volume_target_tokens,turn_idx,total_input_tokens,cache_create,cache_read,output_tokens,auto_compact_fired
```
Where `total_input_tokens = input_tokens + cache_creation_input_tokens + cache_read_input_tokens` (sum of all input categories billed for the turn).

## 7. Determinism + safety invariants
- HOME isolation enforced by every script (assert `$HOME` starts with `/tmp/q1-claude-test-home` or abort).
- No `claude` invocation outside `bin/`. No subagent dispatch from inside the runs.
- Phase 3 archive untouched (separate repo dir, not modified).
- No Codex / Gemini invocation. Q1 is Claude-only (ADR Rule 4-0 narrow scope).
- 12 runs sequential (not parallel) to avoid auth-token rate limits and to keep one jsonl stream per session.
- Estimated wall time: V1≤2 min, V4≤15 min/run (180k tokens × interactive turns). Total budget ≤2h.

## 8. Risks + mitigations
| Risk | Mitigation |
|---|---|
| `-p` mode does not trigger auto-compact | Fallback to interactive driver via `script(1)`. Decision after first V4 probe. |
| Auth token TTL expires mid-batch | Re-copy `~/.claude.json` between runs if `claude` returns auth error; abort + report otherwise. |
| Rate limit at high volumes | Sequential runs only, 30s sleep between runs. |
| jsonl path encoding differs from real `~/.claude/projects/` | Resolve via glob, not hardcoded path: `glob $ISOHOME/.claude/projects/*/<session-id>.jsonl`. |
| cmux Enter bug | N/A — driver is direct `claude` invocation, not cmux/telepty. |

## 9. Reporting
- Sub-spec: this file → reported now via telepty inject (REPORT T2 SUB-SPEC).
- Wait for `APPROVED` from orchestrator. If silent ~10 min → proceed and note in README.
- Final: `runs.csv` + `raw/*.jsonl` + `README.md` → REPORT T2 DONE.
- No interpretation in README. Raw + CSV only. T3 analyst owns analysis.

## 10. Out of scope (for orchestrator confirmation)
- T3 analysis (CI computation, ±5% threshold).
- Q4/Q2 cross-CLI thresholds (Codex/Gemini auto-compact).
- Phase 4c Preuse-compact arm execution.
- Modifying Phase 3 fix4 archive.
