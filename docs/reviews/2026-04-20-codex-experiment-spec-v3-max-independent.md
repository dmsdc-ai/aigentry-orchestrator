# v3-max Spec Independent Review (3rd round)

Verdict: APPROVE_WITH_FIXES

## 1. Structural soundness assessment

- **Descriptive-only approach: partial**
  - Dropping pass/fail significance gates is the right v3-max correction. `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:266-288` now reports per-cell bootstrap CIs instead of the invalid/impossible binary testing path from v2, and that matches HELM's multi-metric reporting philosophy rather than forcing one headline scalar (Bommasani et al., 2023, https://arxiv.org/abs/2211.09110).
  - I re-checked the math here: for a given `(fixture, P-acc)` cell, the 30 observations are one per independent session, so I do **not** see the same per-cell impossibility that broke v2.
  - It is still only partial because the spec does not yet predeclare the architect's decision rule or even the holdout "accuracy" formula that converts descriptive tables into a lock/no-lock decision (`...:146-150`, `...:283-288`, `...:354-366`).

- **Z design natural accumulation: partial**
  - `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:67`, `...:129-133` is a real structural improvement. Thirty independent sessions with balanced positions is the correct fix to the v2 same-fixture rehearsal problem.
  - It remains partial because v3-max now mixes productive task history with evaluation artifacts: every fixture adds 10 planted facts (`...:74-84`) and §5.4 injects 10 post-task probes back into the same continuing session (`...:229-240`, `...:300-310`). That is no longer just "natural accumulation of work."

- **10 facts per fixture: partial**
  - This is directionally sound because it replaces vague drift proxies with explicit leakage targets (`...:200-227`), which is much closer to the actual architectural question.
  - It is still only partial because 10 facts across all 10 fixtures means later `P-acc` positions can carry a large synthetic fact burden that is unrelated to normal aigentry traffic and not cleanly partitioned by fixture.

- **2-family jury: partial**
  - For Layer 2 specifically, this fix is mostly sound. `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:185-190` now uses Claude + Codex rather than one-family prompt variants, which is much closer to the jury paper's intended diversity benefit (Verga et al., 2024, https://arxiv.org/abs/2404.18796).
  - It is only partial because the family balance is still 3:2 and the semantic fallback judges in §§5.3-5.4 are still single-family Claude, so the whole grading stack is not actually "two-family."

- **CLI-only constraint: partial**
  - This is the right ecological-validity choice for an aigentry policy decision. The question is about real CLI orchestration, so measuring the real CLI surface is better than silently switching to SDK-only infrastructure (`...:155-167`, `...:317-323`).
  - It is still partial because v3-max's own call budget is large: `~4,000` pollution CLI calls plus `~7,200` jury calls (`...:321-322`), with retry behavior mentioned but not bounded (`...:323`).

## 2. New critical issues (🔴)

1. **Post-task probes contaminate later `P-acc` fixtures.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:229-240`, `...:300-310`.
   - `P-acc` is defined as one continuing session across 10 fixtures (`...:67`, `...:129-133`), but §5.4 appends 10 probe questions and answers to that same session after every fixture. From fixture 2 onward, the chain is no longer "prior work history"; it is "prior work history + prior evaluation artifacts."
   - External grounding: LongMemEval explicitly compiles the chat history first and asks the evaluation question **after** the interaction history is complete; the maintainers later cleaned histories "to prevent interference on answer correctness" (Wu et al., LongMemEval repo, https://github.com/xiaowu0162/longmemeval, lines 255-258 in the project README).
   - Minimal fix: do not inject probes into the productive `P-acc` session. Run probes against a frozen clone/replay of the just-finished session state, or a separate evaluation session built from the same transcript snapshot.

2. **`S` mode sees the loss probes up front, which reintroduces a mode-specific information confound.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:238-240`.
   - Session modes are probed **after** task completion, but `S` gets "briefing artifact + task + post-probes" in one request. That means the subagent knows during task execution which facts will later be tested. This is not an execution-mode difference; it is an information-structure difference.
   - External grounding: LongMemEval's protocol is "answer the question after all the interaction sessions," not "show the questions during the interaction" (Wu et al., LongMemEval repo, https://github.com/xiaowu0162/longmemeval).
   - Minimal fix: make `S` follow the same two-stage protocol as D/P-fresh/P-acc. First run the task. Then run a second isolated probe pass on the frozen transcript/output.

3. **Cross-fixture planted-fact bleed makes `P-acc` pollution/loss scores position-dependent in an uncontrolled way.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:74-84`, `...:129-133`, `...:202-225`, `...:229-255`.
   - Every fixture contributes 10 planted facts, but the metric only scores the current fixture's 10 facts. In `P-acc`, fixture `Fk` is evaluated inside a session that already contains facts from `F1..F(k-1)`. Later outputs can leak or recall earlier synthetic facts without being counted in the current trial's metric, and the mere presence of those older facts changes the retrieval environment as position increases.
   - External grounding: LongMemEval's construction is question-specific and attribute-controlled; when interference was discovered, the benchmark histories were cleaned rather than tolerated as part of measurement noise (Wu et al., LongMemEval repo, https://github.com/xiaowu0162/longmemeval, lines 255-258).
   - Minimal fix: either score pollution/loss against a chain-level fact inventory with position-aware exposure metadata, or move these metrics to separate probe-only evaluations taken from frozen snapshots rather than in-band per-fixture scoring.

## 3. New high issues (🟡)

1. **Semantic leakage/recall fallback is self-family judging.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:212-223`, `...:245-249`, `...:317-322`.
   - v3-max removed embedding dependencies, but the replacement is Claude CLI semantically judging Claude-generated outputs for both pollution and loss fallback. That is a direct self-/family-preference exposure.
   - External grounding: Zheng et al. identify self-enhancement bias in LLM judges (https://arxiv.org/abs/2306.05685). More directly, recent self-bias work finds that some models, including Claude-family and GPT-family judges, systematically score their own or family outputs higher (Li et al., 2025, https://arxiv.org/abs/2508.06709).
   - Minimal fix: for ambiguous semantic cases, use cross-family judging with self-family abstention, or keep Layer A/B primary and sample only a small blinded human audit set for fallback cases.

2. **Holdout "accuracy" is still undefined, so the lock criterion is not executable.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:146-150`, `...:283-288`, `...:389-390`, `...:416-418`.
   - The spec says "predictive accuracy ≥ 70%" but never defines predicted target, observed target, tie handling, or how the four orthogonal metrics collapse into "actual best mode" on holdout.
   - External grounding: HELM's whole value is standardized scenarios plus standardized metrics under fixed conditions; once the decision rule is left implicit, the same reported table can support multiple incompatible conclusions (Bommasani et al., 2023, https://arxiv.org/abs/2211.09110).
   - Minimal fix: predeclare `predicted_best_mode` and `actual_best_mode` explicitly, including tie margin, lexicographic or Pareto rule, and how compacted holdout cases are scored.

3. **`human_review=true` has no adjudication owner compatible with Rule 21.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:192-194`, `...:377-392`; `docs/rules.md:130-137`.
   - The spec raises a human-review flag but never says who performs the adjudication. Under Rule 21 and Rule 22, the orchestrator cannot directly do ad hoc analysis; it can only route/verify. So the flag as written has no constitutionally valid owner.
   - Minimal fix: assign `human_review=true` cases to `aigentry-architect` (policy interpretation) or `aigentry-analyst` (grading dispute review) explicitly, and state that orchestrator only transports the case/result.

## 4. New medium issues (🟢)

1. **The pre-registration dependencies referenced in the spec do not exist yet.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:345-360`; current tree check shows missing:
     - `docs/superpowers/analysis-plan/2026-04-20-exec-mode-analysis.md`
     - `fixtures/exec-mode-experiment/canonical_briefing.md`
     - `fixtures/exec-mode-experiment/warmup_transcript.md`
   - This is not a conceptual flaw in v3-max, but it means the design is not yet in a pre-registrable state.
   - Minimal fix: create these artifacts before builder handoff, and pin maximum token length / section structure for the shared briefing and warmup assets.

2. **Compact-stratum reporting needs a minimum-`n` rule.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:272`, `...:370-375`.
   - v3-max correctly keeps compact events in the primary report, but it does not say what happens when a stratum has too few observations for a meaningful CI.
   - Minimal fix: predeclare `CI only if n >= k`; otherwise show raw values plus count and suppress interval estimation.

3. **Retry policy is named but not operationalized.**
   - Evidence: `docs/superpowers/specs/2026-04-20-execution-mode-comparison-experiment-design.md:323`.
   - "Exponential backoff" without max retries, timeout, or partial-failure accounting is not enough for a job of this size.
   - Minimal fix: pin per-call timeout, max retries, cool-off schedule, and whether exhausted calls count as missing, failed, or rerunnable.

## 5. Operational risks

- `2,400` productive trials plus `~11,200` grading calls is a real batch system, not a script. Builder needs resumable checkpoints, per-phase logs, and idempotent reruns from day one.
- The pilot gate is good, but the pre-registration section should explicitly allow pilot-driven abort/re-spec. A git tag should lock the design version, not force execution after a design-breaking pilot result.
- Fixture authoring load is high: 10 fixtures x setup history x 10 facts x 10 probes x primary graders. A fixture-QA owner should be named before builder starts.
- Judge-time is likely to dominate wall-clock unless grading is parallelized and checkpointed independently from task execution.

## 6. Aigentry-specific concerns

- The spec's delegation split is directionally correct, but `human_review` needs an explicit non-orchestrator owner or it conflicts with `docs/rules.md:130-137`.
- This experiment still measures **serial single-task routing**, not the full Rule 4 policy surface. Any eventual AGENTS change should say that plainly unless a separate parallelism/throughput experiment is added.

## 7. Strengths (⭐)

- v3-max fixes the major v2 statistical failure cleanly by dropping the invalid pass/fail significance path.
- The `P-acc` redesign to 30 independent sessions with balanced positions is the right structural move.
- Per-fixture primary graders are now the actual primary quality signal; the jury is secondary. That is much closer to benchmark best practice than the earlier generic-rubric drift.
- Pollution/loss are now explicit contamination/retrieval probes rather than cosine distance from a fresh answer.
- Compact events are kept in the primary report instead of being filtered away.

## 8. Recommendation

- **APPROVE_WITH_FIXES**: patch the spec, then hand to builder.
- Exact fix list:
  1. Remove in-band post-task probes from productive sessions; probe from frozen snapshots only.
  2. Make `S` use the same two-stage probe protocol as the session modes.
  3. Redesign planted-fact accounting for `P-acc` so cross-fixture facts do not silently bleed into later per-fixture pollution/loss scores.
  4. Replace single-family Claude semantic fallback with cross-family judging or limited human audit on ambiguous cases.
  5. Define holdout accuracy formally, including tie handling and compacted holdout cases.
  6. Assign `human_review` adjudication to a valid non-orchestrator session.
  7. Add the missing analysis-plan / briefing / warmup artifacts and pin retry + compact-stratum rules before builder handoff.
