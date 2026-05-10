# Experiment Spec Review — Execution Mode Comparison

Verdict: REQUEST_REVISION

## Critical issues (🔴)

1. Mode pre-state is not controlled across D/P/S — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:49`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:52`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:64`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:65`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:177` — Persistent gets fixture-specific prior turns and warm-up history, while Dynamic/Subagent are only defined as fresh execution plus the task prompt. For the memory-bearing fixtures, that changes the information available to the agent rather than isolating execution mode, so the D vs P vs S comparison is not a fair control. Proposed fix: for every fixture that depends on prior context, define one canonical setup transcript and replay it identically for P, while passing the same transcript to D/S as a briefing artifact or transcript replay, with those briefing tokens counted in cost.

2. Persistent seeds are not independent replications — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:49`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:79`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:84` — The spec reuses one persistent session for all five seeds of a fixture and then randomizes trial order globally. Later seeds can inherit earlier outputs, summaries, or compaction artifacts from the same session, so seed variance no longer measures only model stochasticity. Proposed fix: use one persistent session per `(fixture, seed)` with identical warm-up, or restore the same transcript snapshot before every seed; randomize across those independent trials only.

3. The planned McNemar analysis is invalid at the stated unit of analysis — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:79`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:158`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:165`, supported by `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:106` and `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:108` — The spec says McNemar is run "per-fixture," but each fixture-mode pair has only 5 paired seeds. The `>=25 discordant pairs` condition cannot be met per fixture, and the total `150 runs` is not the paired sample size for that test. Proposed fix: predeclare exact McNemar/binomial for binary outcomes, or aggregate binary outcomes at a higher unit with enough paired observations; use the pilot to estimate discordant counts before locking the inferential test.

4. `Pollution_rate` is not operationalized as contamination — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:130`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:133`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:135`, supported by `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:66` and `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:81` — Cosine divergence from a fresh dynamic output measures "difference from D," not harmful carry-over. On open-ended fixtures, a better or simply different answer will score as more polluted, which breaks construct validity for one of the four primary axes. Proposed fix: define pollution using deliberate contamination probes with irrelevant prior context, then score leakage of those irrelevant facts, patterns, or styles via deterministic checks or a blinded judge; keep generic embedding similarity as a secondary diagnostic only.

## High issues (🟡)

1. Cost comparison hides persistent bootstrap and warm-up cost — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:52`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:54`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:105`, supported by `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:28` and `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:30` — Excluding all warm-up/bootstrap tokens from the main comparison makes persistent look cheaper at the exact decision point the experiment is meant to inform. Proposed fix: report both `marginal_cost` and `amortized_cost(n)` with a predeclared amortization horizon.

2. The 200K/compact policy is post-hoc and can bias the result set — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:230` — "`exclude 여부 검토`" after observing outcomes is not a valid analysis rule for a core mode behavior. Compaction is part of persistent-session reality, so exclusion rules must be fixed before execution. Proposed fix: pre-register compact-event detection, whether compacted trials count as failures or a separate stratum, and whether replacement trials are allowed.

3. The embedding backend is not fixed, so pollution scores are not reproducible — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:134` — Allowing `voyage-3-large` or `text-embedding-3-small` means the metric definition can change after data collection starts. Proposed fix: choose one embedding model/version now and log it in every `metrics.json`; treat any later model swap as a new experiment.

4. The aigentry-specific slice is a one-day convenience sample, so the decision tree risks overfitting today's workflow mix — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:15`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:22`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:68`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:76`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:235` — The current fixtures are realistic, but there is no sampling rule or holdout step before the results become AGENTS policy. Proposed fix: keep these five as development fixtures, then require a small unseen holdout batch from a later session before changing the delegation rule.

## Medium issues (🟢)

1. Executable fixture reset and environment are under-specified — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:63`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:72`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:206`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:210` — `npm test` and git-commit grading require a pinned reset protocol, repo state, and toolchain version to keep runs comparable. Proposed fix: define per-trial fixture reset commands, git-state restoration, and runtime/toolchain versions in the harness contract.

2. Randomization is not pre-registered — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:84` — "`Latin square 또는 Python random.shuffle`" leaves the ordering method open until execution. Proposed fix: select one randomization method now and persist the RNG seed in run metadata.

3. Judge disagreement remediation is incomplete — `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:126`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:231` — The spec sets `alpha >= 0.8` and says to adjust the rubric if it fails, but it does not say whether earlier judgments are discarded, re-run, or adjudicated by a third judge. Proposed fix: predefine a rejudging path with trigger, ownership, and whether already-scored trials must be rescored.

## Strengths (⭐)

- The spec correctly treats cost, quality, pollution, and loss as orthogonal primary metrics instead of forcing an early composite score (`docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:34`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:148`, `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:40`, `~/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:81`).
- It mixes deterministic grading with rubric judging, which is the right bias for code/edit tasks where objective signals exist (`docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:118`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:124`).
- A pilot phase is already present before the full run, which gives the project a natural point to tune execution and variance assumptions (`docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:218`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:219`).
- Restricting the comparison to Claude-only is a sound way to reduce model-family confounding for this first architectural decision (`docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:27`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:37`).

## Methodology assessment

The document has the right experimental ambition: it mixes benchmark-class and product-specific fixtures, separates metrics instead of collapsing them, and includes a pilot stage. The problems are concentrated in the causal core of the design. Right now the spec does not hold information state constant across modes, does not keep persistent seeds independent, and does not define one of its four primary metrics in a way that isolates the construct it names. Those are not polish issues; they affect whether the resulting decision tree can be defended as evidence-based.

## Operational assessment

The harness shape is realistic, but the execution protocol is not fully pinned down yet. Persistent-session compaction, fixture reset rules, embedding backend choice, and judge-remediation flow all need pre-registered handling before builder work starts, otherwise the implementation will bake in ad hoc decisions. The pilot/full-run split is useful, but the spec should convert that into explicit stop/go gates tied to variance, compact rate, and judge reliability. Once those controls are written down, this remains feasible as an internal product experiment rather than an academic benchmark.

## Recommendation for proceeding

Block execution and re-spec before handing this to builder. The revised spec should, at minimum:

- define matched pre-state delivery for every context-bearing fixture across D, P, and S
- make persistent seeds independent by snapshotting or recreating pre-state per seed
- replace the current McNemar plan with an exact or otherwise valid binary-outcome test
- redefine pollution as measured contamination, not generic embedding divergence from D
- pre-register warm-up cost accounting, compact handling, embedding backend, and fixture reset protocol

After those fixes are written into the spec, proceed to builder for harness work.
