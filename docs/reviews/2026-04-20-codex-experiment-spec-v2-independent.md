# v2 Spec Independent Review

Verdict: REQUEST_REVISION

## 1. v2 fix soundness assessment

- **C1: partial**
  - `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:53-59` is a real improvement over v1 because it at least pins one canonical pre-state. But "briefing artifact" is still underspecified. If D/S get a summarized brief while `P-fresh` gets a replayed turn history, the experiment is no longer equalizing only execution mode; it is also changing discourse structure and retrieval affordances. That matters for the exact abilities the spec wants to measure, especially knowledge updates and semantic masking ([LongMemEval](https://arxiv.org/abs/2410.10813), [Shi & Penn 2025](https://aclanthology.org/2025.wraicogs-1.2/)).
  - Minimal fix: require the D/S artifact to be the same raw, turn-delimited canonical transcript, not a prose summary.

- **C2: partial**
  - `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:54-60`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:103-107` does fix the v1 problem for `P-fresh`: seeds are now independent.
  - It does **not** fully resolve the measurement problem for `P-accumulated`, because the spec still labels five sequential exposures in one session as "seeds." That turns replication index into repeated-task exposure, which is a different construct from stochastic replication.

- **C3: unsound**
  - `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:197-203` correctly moves away from normal-approximation McNemar when paired counts are sparse; exact tests are the right family in that setting (see `/Users/duckyoungkim/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:104-108`).
  - The fix is still unsound because the paired unit is undefined. The text says "per fixture" but then claims `5 seeds × 10 fixtures = 50 per pair`, which pools heterogeneous fixtures into one binary test while `P-accumulated` seeds remain serially dependent.

- **C4: partial**
  - `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:154-167` is directionally sound. Deliberate contamination with deterministic primary checks is a much better construct than cosine divergence, and it matches the benchmark-contamination literature's push toward withheld or dynamically generated probes rather than similarity heuristics ([Deng et al. 2024](https://arxiv.org/abs/2311.09783), [GSM1k / NeurIPS 2024](https://papers.nips.cc/paper_files/paper/2024/file/53384f2090c6a5cac952c598fd67992f-Paper-Datasets_and_Benchmarks_Track.pdf)).
  - It is only partial because deployment scope is unclear. `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:252-265` only defines explicit pollution artifacts for `Fa`, not the other fixtures.

## 2. New critical issues (🔴) — missed by v1 reviewer

1. **The acceptance criterion is mathematically impossible under the stated per-fixture exact-binomial plan.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:197-203`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:311-317`
   - The spec says binary outcomes use an exact binomial test, then later requires "3+ mode pair × fixture" results with `p < 0.0083`. If a fixture really has only 5 paired observations, the smallest possible one-tailed exact-binomial p-value is `1/32 = 0.03125`.  
     **Inference from the stated n and exact-binomial math**: the success gate cannot be met as written.
   - Why this matters: the experiment can finish cleanly and still fail its own lock criterion for purely mathematical reasons, which makes the decision rule unusable.
   - Minimal fix: either raise per-fixture sample size, or move significance claims to a hierarchical/pooled analysis while downgrading per-fixture results to descriptive evidence.

2. **`P-accumulated` is measuring repeated exposure and rehearsal, not just natural accumulation.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:55-60`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:103-113`
   - The same fixture is run five times in one persistent session. Later "seeds" can benefit from earlier failed attempts, earlier model-generated fixes, and explicit self-corrections. That is not a natural proxy for normal aigentry work, where sessions accumulate across different tasks, not five replays of the same task.
   - External grounding: long-memory benchmarks emphasize evolving histories, knowledge updates, and multi-session reasoning rather than repeated attempts on the same latent instance ([LongMemEval](https://arxiv.org/abs/2410.10813)).
   - Minimal fix: make `P-accumulated` one natural task chain per session, or use one exposure per persistent session and replicate over independent fixture variants.

3. **Compact handling conditions away a core failure mode of persistent context.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:275-279`
   - The spec excludes compacted trials from primary analysis and allows replacement reruns. If `P-accumulated` compacts more often, the primary comparison becomes "persistent sessions that did not compact" rather than the actual mode the policy is supposed to govern.
   - External grounding: HELM's whole point is to surface trade-offs rather than filter inconvenient dimensions out of the headline result ([HELM](https://arxiv.org/abs/2211.09110)); long-term-memory work likewise treats sustained-interaction degradation as part of the capability, not a nuisance variable ([LongMemEval](https://arxiv.org/abs/2410.10813)).
   - Minimal fix: compact should count in primary analysis, either as an explicit failure mode or as a separate reported operating point without replacement.

## 3. New high issues (🟡)

1. **Section 4.2 and Section 5.2 disagree on what the primary quality metric is for several fixtures.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:75-76`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:84-86`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:139-153`
   - `F3`, `F7`, and `F10` are defined with task-specific graders, but Section 5.2 routes them into a generic 5-dimension LLM jury. That is construct drift: the task definitions say "measure exact issue IDs/latest-decision/stale rejection," while the judge rubric says "correctness/completeness/efficiency/edge-case/style."
   - External grounding: task-specific benchmarks normally use task-specific preferred metrics rather than a one-rubric-fits-all overlay ([BIG-bench](https://friedeggs.github.io/files/2206.04615.pdf), [LongBench](https://arxiv.org/abs/2308.14508)).
   - Minimal fix: declare one primary grader per fixture and make jury scores secondary or fallback only.

2. **The cited jury paper supports diverse model families, but the spec uses three Claude judges.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:148-152`
   - The spec cites "Replacing Judges with Juries" to justify the panel, but that paper's reported bias reduction comes from a panel composed of disjoint model families, not prompt variants of one family.
   - External grounding: Verga et al. explicitly attribute lower intra-model bias to the jury's composition of "disjoint model families" ([Verga et al. 2024](https://arxiv.org/abs/2404.18796)).
   - Minimal fix: either diversify the judges, or stop claiming the Verga-style bias benefit and treat the panel as a reliability hedge only.

3. **The randomization plan is internally inconsistent with `P-accumulated`'s sequential semantics.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:55`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:109-113`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:268-271`
   - The document says `P-accumulated` seeds 1-5 run sequentially in one session, but also says the full 200-trial order is globally shuffled and precommitted. The builder cannot satisfy both unless the shuffle is constrained by within-session ordering rules.
   - External grounding: variance work supports randomization, but order must respect the actual treatment definition rather than scramble it (see `/Users/duckyoungkim/projects/aigentry-dustcraw/research/2026-04-20-agent-mode-benchmarking-methodologies.md:89-90`).
   - Minimal fix: use blocked randomization with fixed intra-session order for `P-accumulated` and randomized block order across fixtures/modes.

4. **The holdout protocol is too weak to justify "Rule 4 lock."**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:115-121`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:317`
   - "Next week's 2-3 natural unseen tasks" is not a robust lock criterion. It is tiny, same-operator, and has no fallback if the sprint does not naturally produce the right task mix.
   - External grounding: contamination work increasingly uses withheld or dynamically generated evaluation sets with predeclared release/usage conditions because public or convenience-sampled holdouts are easy to overfit or game ([Deng et al. 2024](https://arxiv.org/abs/2311.09783), [GSM1k / NeurIPS 2024](https://papers.nips.cc/paper_files/paper/2024/file/53384f2090c6a5cac952c598fd67992f-Paper-Datasets_and_Benchmarks_Track.pdf)).
   - Minimal fix: predeclare minimum holdout count, selection rule, and fallback generation path before using holdout to lock AGENTS policy.

## 4. New medium issues (🟢)

1. **`n=30` amortization is pre-registered but not justified strongly enough to anchor decisions.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:127-134`
   - A single amortization horizon can flip the ranking between fresh and persistent modes. For an architectural decision, this should be a sensitivity analysis, not one fixed headline number.

2. **The pollution instrumentation is under-specified outside `Fa`.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:161-165`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:252-265`
   - Section 5.3 reads like every fixture can carry a planted irrelevant fact, but the fixture package only gives explicit contamination artifacts to `Fa`. That is likely to produce silent builder interpretation drift.

3. **Subagent token accounting is only specified for one nesting level.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:135`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:231`
   - If a subagent spawns further subagents, the accounting contract does not say whether those logs roll up transitively or are treated as separate children.

4. **The risk-budget math for the judge panel is not internally credible yet.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:148-152`, `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:306`
   - The document estimates `~3000` judge calls for 5 open fixtures, but the stated design implies a much different number depending on whether judging is per-output or per-pair. That is a planning smell, not just arithmetic noise, because rate-limit and budget risk depend on it.

## 5. Implementation risks for builder phase

- The harness is feasible, but not as a casual "small script." `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:212-237` bundles session setup/teardown, usage parsing, sequential reveal, post-task probes, compact detection, and dual-path grading into one control plane. That needs phased implementation and smoke tests.
- `F7` and `F10` need fixture QA before any full run. Their signal depends on the setup being neither too obvious nor too lossy; otherwise they collapse into either trivial recall or snapshot-quality testing.
- The builder needs a blocked order generator, not a flat `random.shuffle`, or Section 4.1 and Section 4.4 cannot both be true.
- Judge orchestration needs a concrete execution plan: rate-limit behavior, retry policy, and whether order-swap doubles calls or is implemented inside one prompt.
- Cost parsing should explicitly test nested subagent traces before the pilot, not after.

## 6. Aigentry-specific concerns

- **Rule 21 / Rule 22 boundary is still underspecified at decision time.** `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:281-295` delegates build and analysis correctly, but it never says who arbitrates ambiguous findings before AGENTS policy changes. That matters because `docs/rules.md:130-134` forbids the orchestrator from doing ad hoc analysis or hypothesis generation.
- **The spec is narrower than the policy it intends to change.** The goal is a delegation decision tree for AGENTS (`docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:13-15`), but the scope explicitly excludes parallel multi-agent behavior (`docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:41-45`) while `docs/rules.md:57-63` makes parallel breakdown mandatory. Any resulting rule should therefore be labeled "serial single-task routing only."
- **The experiment risks favoring direct execution in a system structurally optimized for delegation.** That is not proof of bias, but it is a governance risk because the conclusions feed back into Rule 4 itself. A predeclared "claims boundary" would help: what this experiment can change, and what requires a second throughput/parallelism experiment.

## 7. Strengths (⭐)

- v2 is materially better than v1. The biggest rejected flaws were not ignored; they were taken seriously and mostly fixed in the right direction.
- `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:58-60` is a real control improvement over the old pre-state mismatch.
- `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:154-167` replaces a weak pollution proxy with a contamination-based construct that is much closer to the architectural question.
- The fixture set is now much more discriminative. `Fa` plus the hardened `F7/F10` family makes the suite meaningfully sensitive to harmful carry-over, not just helpful memory.
- `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:125-137` correctly separates marginal and amortized cost instead of hiding bootstrap overhead.
- The phase split across builder / analyst / architect is directionally aligned with orchestrator governance rather than collapsing everything back into one actor.

## 8. Recommendation

- **REQUEST_REVISION**: block builder handoff until the following are fixed in the spec.
- Rewrite Section 6 and Section 11 so the inferential unit is valid and the success gate is achievable.
- Redesign `P-accumulated` so it measures natural accumulation, not five rehearsals of the same fixture.
- Move compact events into primary reporting rather than excluding and replacing them.
- Declare a single primary quality metric per fixture and keep jury scoring secondary.
- Replace flat global shuffle with blocked randomization that preserves `P-accumulated` ordering semantics.
- Strengthen holdout from "2-3 next-week tasks" to a predeclared, non-convenience validation rule.
- Limit any post-experiment AGENTS changes to **serial single-task routing** unless a follow-up parallelism experiment is added.
