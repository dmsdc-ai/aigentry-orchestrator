---
measured_at: 2026-09-05
models:
  - {label: fable-5.1,   cli: claude, model: "claude-fable-5-1[1m]"}
  - {label: gpt-6-astra, cli: codex,  model: "gpt-6-astra"}
  - {label: grok-4.6,    cli: grok,   model: "grok-4.6"}
  - {label: gemini,      cli: gemini, model: "gemini-3.8-flash-high"}
default_table:            # deterministic fallback, role -> label; used when the LLM call fails
  architect: fable-5.1
  analyst:   fable-5.1
  researcher: grok-4.6    # was gemini: headless web search measured working on grok, auto-denied on agy (see body)
  coder:     gpt-6-astra
  tester:    gpt-6-astra
  builder:   gpt-6-astra
  logger:    gemini       # was grok-4.6: cheapest/fastest for trivial text; workspace file writes allowed headless
---
# Model routing profile (task #1082)

Tags: `claim:` vendor-reported · `bench:` independent leaderboard · `measured:` this session, 2026-09-05 · `unmeasured` = nothing found. Dates 2026; prices USD per 1M tokens in/out.

## fable-5.1 — `claude -p --model 'claude-fable-5-1[1m]'`
- **Strengths.** bench: #1 AA Intelligence Index, 66 (v4.1.1, 09-01) / 57 (v4.2, 09-04); Terminal-Bench 2.1 91.4%; GDPval-AA v2 1853 (#1); AA Coding Agent Index 70 vs Astra 67 [S1,S2,S4]. claim: Terminal-Bench 4.0 55.8% (Opus 5 52.3, Sol 37.3); HLE with tools 65.0% (Astra 57.2) [S3,S5].
- **Weaknesses.** bench: hallucinates more than Fable 5 (attempts 72.6% of unanswerable items vs 63.6%) [S1]; slowest and priciest of the four on AA v4.2: TTFT 266 s, $6.12/task [S2]. claim: trails Astra on TB 4.0 and ARC-AGI-3 [S5]. SWE-bench Pro for 5.1: unmeasured (Fable 5 = 80.0%, #1, llm-stats 09-05 [S6]).
- **Best for:** architecture/spec, cross-module integration, debugging with unclear cause, long-horizon work needing judgment [S7]. **Avoid for:** boilerplate, notes/logs, cost- or latency-bound work.
- **Cost/ctx:** $10/$50, cache read $0.25; 1M ctx, 128K out; cutoff Jun 2026 [S7].
- **CLI (claude 2.1.261).** measured: `claude -p --model 'claude-fable-5-1[1m]'` → 9 s; `--bare` outside a project fails "Not logged in". JSON output, `--mcp-config`, `--agents` (subagents), `-w/--worktree`, `--permission-mode`, built-in web search; only candidate with this repo's MCP/hook stack wired.

## gpt-6-astra — `codex exec -m gpt-6-astra`
- **Strengths.** claim (OpenAI launch 09-03, via [S5]; openai.com 403 here): Terminal-Bench 4.0 57.7%, DeepSWE v1.1 74.1%, BrowseComp 91.5%, SRE-Bench 88.0% (Fable 5.1 12.5%). bench: ARC-AGI-3 0.999 #1 (llm-stats 09-05) [S6]; AA Coding Agent Index 67 at 1/5 the tokens of Opus 5 [S4]; $2.57/task on AA v4.2 vs Fable 5.1 $6.12 [S2].
- **Weaknesses.** bench: AA Index 61 (v4.1.1) / 55 (v4.2), #2 behind Fable 5.1; TTFT 250 s at max effort [S2,S4]. claim: loses HLE with tools 57.2 vs 65.0 [S5]. SWE-bench, TB 2.1: unmeasured.
- **Best for:** well-specified implementation, refactors, ports, test authoring, build/compile loops, ops/SRE-shaped failures, computer use. **Avoid for:** open-ended design judgment; tiny tasks (priced like Fable).
- **Cost/ctx:** $10/$50, cached $1; 1.05M ctx (922K max input), 128K out; >272K input billed 2x; cutoff Apr 2026 [S8].
- **CLI (codex 0.153.4).** measured: `codex exec -m gpt-6-astra -s read-only` → 8 s. Sandbox `-s read-only|workspace-write|danger-full-access`, `-a never`, `--search` (web), JSON output, `mcp`; no worktree flag; subagents unmeasured; model pin needs `-m` (#1083).

## grok-4.6 — `grok -p … --always-approve -m grok-4.6`
- **Strengths.** claim (model card 08-12 rev 08-17, internal harness): DeepSearchQA 81.6%, hallucination 1.7%, GDPval-AA 1753 [S9]. bench: AA Index 61 (v4.1.1, = Sol) / 51 (v4.2); fastest TTFT of the four, 52 s; $1.25/task [S1,S2]. measured: headless web search works unconfigured (ripgrep-release probe, `--max-turns 4`, cited URL in 16 s).
- **Weaknesses.** claim: Terminal-Bench 3.0 26.0% (Sol 34.6, Fable 5 34.1); DeepSWE 65.9 vs Sol 73 / Fable 5 70 [S9,S10]. bench: absent from SWE-bench Pro and TB 2.1 lists (Grok 4.5: 64.7 / 83.3) [S6]. Card honesty/sycophancy rows: secondary coverage reads them as regressions vs 4.5, unverified here.
- **Best for:** web/upstream research, doc sweeps, factual lookups, cheap parallel fan-out. **Avoid for:** long terminal agent runs (TB 3.0 gap), hardest integration coding.
- **Cost/ctx:** $2/$6 (<200K; $4/$12 above), cached $0.50; 500K ctx, no output cap; cutoff Jan 2026; effort up to xhigh [S11].
- **CLI (grok 0.2.93).** measured: `grok -p … --always-approve --max-turns 1 -m grok-4.6` → 13 s. JSON output, `--reasoning-effort`, `--agents` (subagents), `-w/--worktree`, `--sandbox`, `mcp`, web search on by default.

## gemini — `agy -p … --model gemini-3.8-flash-high` (binary is Antigravity `agy`; gemini-cli only as fallback)
- **Strengths.** bench: Terminal-Bench 2.1 #1, 89.4% (llm-stats 09-05; Opus 5 89.1) [S6]; AA Index 59 (v4.1.1) / 47 (v4.2); cheapest of the four, $0.74/task [S2]. claim (Google 09-02): HLE-Verified 54.9%, DeepSWE v1.1 73.7% (≈ Astra) [S12,S13]. measured: fastest round trip here, 6 s.
- **Weaknesses.** claim (Google evals table is image-only; numbers via [S13]): Terminal-Bench 4.0 19.1% (Opus 5 51.8), GDPval-AA 1545 (Opus 5 1824). Model card: "occasional slowness or timeout issues"; cutoff Mar 2026 [S14]. Search/research, SWE-bench: unmeasured.
- **Best for:** bounded coding/test tasks, docs summarization, long-document reading (1M ctx), high-volume cheap work, notes/logs. **Avoid for:** long autonomous terminal runs; tasks needing web/URL or shell tools unless the adapter grants permissions.
- **Cost/ctx:** $0.75/$3.75 until 2026-12-31, then $1.50/$7.50; 1M ctx, 64K out [S12,S14].
- **CLI (agy 1.1.27; gemini-cli 0.53.0).** measured: `agy models` lists 3.8/3.7/3.6-flash-{high,medium,low} and 3.1-pro-{high,low}; default 3.8 Flash (6 s); 3.1-pro-high 11 s. Headless web probe: `read_url` auto-denied → **empty output, rc 0** unless `--dangerously-skip-permissions` or a `permissions.allow` rule; shell soft-denied, workspace file ops allowed [S15]; issue #548 (headless ignores permissions.allow) still open. JSON output, `--effort`, `--sandbox`, `mcp`; no worktree flag; subagents unmeasured. gemini-cli: measured `gemini -p` blocks on an OAuth "[Y/n]" prompt (killed at 90 s). 3.1 Pro not chosen: AA v4.2 37 vs 47 [S2].

## Comparison (2026-09-05)
| | fable-5.1 | gpt-6-astra | grok-4.6 | gemini (3.8 Flash) |
|---|---|---|---|---|
| AA Index v4.1.1 / v4.2 | 66 / 57 | 61 / 55 | 61 / 51 | 59 / 47 |
| Terminal-Bench 4.0 (claim) | 55.8 | 57.7 | TB 3.0: 26.0 | 19.1 |
| DeepSWE 1.1 claim / AA Coding Agent | unmeasured / 70 | 74.1 / 67 | 65.9 / unmeasured | 73.7 / unmeasured |
| Research signal | HLE+tools 65.0 claim | BrowseComp 91.5 claim | DeepSearchQA 81.6 claim; headless search measured OK | unmeasured; URL tool denied headless |
| Price in/out · AA $/task · TTFT | $10/$50 · $6.12 · 266 s | $10/$50 · $2.57 · 250 s | $2/$6 · $1.25 · 52 s | $0.75/$3.75 · $0.74 · n/a |

## Routing rubric
Route to **fable-5.1** when the task needs judgment over a large or unfamiliar codebase, architecture or spec work, integration across modules, or debugging with unclear cause, and cost is secondary. Route to **gpt-6-astra** for well-specified implementation, refactors, ports, test authoring, build/compile loops, ops/SRE-shaped failures, and anything terminal- or computer-use-heavy. Route to **grok-4.6** for web or upstream research, documentation sweeps, factual lookups, and cheap parallel fan-out where a first pass is enough. Route to **gemini** for bounded coding/test tasks, notes/logs, and long-document reading when cost matters and no web/shell tools are needed beyond what the adapter grants; never for long autonomous terminal runs. Two qualify → the cheaper; unsure → role default.

## Sources
[S1] artificialanalysis.ai/articles/claude-fable-5-1 · [S2] artificialanalysis.ai/leaderboards/models, /changelog · [S3] anthropic.com/claude-fable-and-mythos-5-1 · [S4] artificialanalysis.ai/articles/benchmarking-gpt-6-astra · [S5] vellum.ai/blog/gpt-6-astra-benchmarks-explained · [S6] llm-stats.com/benchmarks/{swe-bench-pro,terminal-bench-2.1,arc-agi-3} · [S7] platform.claude.com/docs/en/docs/about-claude/models/overview · [S8] platform.openai.com/docs/models/gpt-6-astra · [S9] media.x.ai/v1/website/card-4p6-4cd2dc57.pdf · [S10] x.ai/news/grok-4-6 · [S11] docs.x.ai/developers/grok-4-6 · [S12] blog.google/innovation-and-ai/models-and-research/gemini-models/3-8-flash-and-3-8-flash-cyber/ · [S13] storage.googleapis.com/deepmind-media/gemini/gemini_3-8_flash_model_evaluation.pdf + vellum.ai/blog/gemini-3-8-flash-benchmarks-explained · [S14] deepmind.google/models/model-cards/gemini-3-8-flash/ · [S15] antigravity.google/docs/cli/headless/, github.com/google-antigravity/antigravity-cli issues 76/318/548. Aider polyglot stale (2025-11-20); LiveCodeBench lists none of the four.
