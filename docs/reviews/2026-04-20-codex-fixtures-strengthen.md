# Fixtures Strengthening Dialogue — Task #329

I am not reopening the v2 items you already fixed (`pre-state control`, `seed independence`, `McNemar invalidity`, `pollution construct`). This is only about whether the **fixture set itself** is discriminative, hard to game, and aligned with the delegation decision you want to make.

## 1. Coverage gap analysis

The current 10-fixture set is directionally good. It already spans:
- bounded one-shot work
- isolated review/research work
- iterative context-carrying work

That is enough to learn a first-order D vs P vs S story. The main gaps are narrower and more important than broadening the surface area.

First, the set still under-tests **harmful carry-over**. Several fixtures reward remembering useful context, but almost none punish remembering **wrong** context. That is a problem because pollution is one of the four primary axes. If you do not include at least one fixture with a planted false prior or superseded decision, you will measure "memory helps" much better than "memory harms."

Second, you need one nontrivial case where **freshness wins for the right reason**. Right now the clearest D/S-favoring case is F1, but F1 is so easy that it mostly measures shell/tool access. That does not teach the delegation threshold much. You want at least one case where P-accumulated can lose because stale history is actively dangerous, not because the task is trivial.

Third, the set only lightly probes **semantic masking / supersession**. F7 and F10 are the right family, but they do not yet force the model to retrieve the latest valid decision from among several semantically similar earlier decisions. That is the failure mode long-context work usually breaks on, and it is exactly the sort of thing that matters for aigentry sessions in practice.

Fourth, the **realism vs controllability ratio** is close to right. Roughly half replay-style and half synthetic is fine for a first product experiment. I would not move the ratio much. I would change one fixture, though: replace the most literal replay task (F1) with a semi-synthetic pollution trap built from a real aigentry failure pattern. That keeps realism while reducing "today's workflow overfit."

Fifth, there are real product gaps I would **defer**, not add here: parallel multi-agent decomposition, deliberation, cross-LLM handoff, and long-running watch/log tasks. Those change the experimental unit from "single execution mode" to "orchestrated workflow." They are high value, but they belong in the next experiment, not this one.

Concrete evidence behind the cautions:
- LLM judges are known to show **position** and **verbosity** bias, so rubric-scored open outputs are gameable without stronger judging controls ([Zheng et al. 2023](https://papers.nips.cc/paper_files/paper/2023/file/91f18a1287b398d378ef22505bf41832-Paper-Datasets_and_Benchmarks.pdf), [Shi et al. 2025](https://arxiv.org/abs/2406.07791)).
- Long-context retrieval degrades more from **semantic masking** than from raw length alone, so a clean "needle" is not enough if the real failure is choosing among similar prior decisions ([Shi & Penn 2025](https://aclanthology.org/2025.wraicogs-1.2/)).
- Static public benchmarks are vulnerable to contamination and near-duplicate overfit, so the more a fixture can be templated or withheld until run time, the better ([Deng et al. 2024](https://aclanthology.org/2024.naacl-long.482/), [OpenAI GSM1k paper, NeurIPS 2024](https://proceedings.neurips.cc/paper_files/paper/2024/file/53384f2090c6a5cac952c598fd67992f-Paper-Datasets_and_Benchmarks_Track.pdf)).

## 2. Adversarial robustness per fixture

| Fixture | Attack vector | Severity | Hardening |
| --- | --- | --- | --- |
| F1 | One shell command (`cp` + `git commit`) passes. This measures tool access, not mode capability. | High | Drop it from the core set, or at minimum parameterize it with hidden instance variation and an extra constraint that cannot be solved by a blind copy alone. |
| F2 | Generic "slim the doc" advice can sound actionable while silently dropping rules; LLM judge may reward polish and length. | High | Add a hidden preservation checklist of mandatory rules/invariants and require an explicit old->new mapping table. Judge pairwise with swapped order. |
| F3 | Spray many plausible findings to inflate recall; if count is the main signal, false positives are cheap. | High | Grade matched issue IDs with precision and recall, not raw count. Add distractor lines that look suspicious but are correct. |
| F4 | Invented Mermaid edges/modules can look credible; diagram count is easy to satisfy without real understanding. | Medium | Grade extracted module/edge triples against an oracle and penalize hallucinated nodes/relations. Require file references for each major edge. |
| F5 | Hallucinated or low-value citations can hit word/source quotas; memorized static knowledge can pass without real retrieval. | High | Live-check URLs, require at least N primary sources, and sample-check claim-to-citation alignment on 3 claims. Use a topic with version/date sensitivity. |
| F6 | If the whole error chain is visible up front, S/D can solve it in one batch and the fixture stops measuring iterative memory. | High | Reveal failures sequentially only after each submitted fix. Count turns and final pass; do not preload future errors. |
| F7 | The task can leak the answer if it names the pattern, or the file may make the choice obvious. Then recall is unnecessary. | High | Do not name the decision in the task turn. Include multiple plausible alternatives in setup history and require citing the chosen prior turn. |
| F8 | Agent can satisfy tests with a local workaround, keep duplication, or edit tests if not constrained. | Medium | Freeze tests, add hidden regression tests, and score duplication reduction structurally, not only via pass/fail. |
| F9 | The bug may be inferable from the current file alone, so prior-turn memory becomes irrelevant. | High | Make the symptom compatible with multiple causes and ensure only setup history identifies the exact root cause. Grade exact blame + fix. |
| F10 | If `.context-snapshot.md` is too complete, every mode can load it and tie; if too lossy, it measures snapshot quality, not mode resilience. | High | Make the snapshot intentionally incomplete in small ways and grade continuity against a hidden unresolved-state checklist, including stale-task rejection. |

## 3. Mode-strength preservation check

### Cluster 1 — Mechanical / One-shot

I would rename this mentally to **fresh-context / bounded-scope**. F4 and F10 are not mechanical in the same sense as F1.

The intended strength is reasonable: D and S should benefit when the task is local, bounded, and does not need long session carry-over. But today only F1 cleanly expresses that, and F1 is too trivial to be useful. F4 is fine for D/S only if you keep it single-pass and make the grader factual. F10 is only a D/S-friendly bounded task if the resume artifact is good enough to use but not good enough to erase the difference between "remembered session state" and "reconstructed state."

Net: the cluster concept is valid, but F1 is the wrong representative. Replace F1 rather than defend it.

### Cluster 2 — Independent / Research

This cluster is the cleanest. F3 and F5 both fit the "isolated sidecar task" story that should favor S.

The catch is that both fixtures are currently **judge-sensitive**. For F3, over-reporting is cheap unless false positives are penalized. For F5, word count and source count invite citation padding. If you fix those graders, this cluster becomes strong evidence for when isolated delegation is worth the overhead.

### Cluster 3 — Context-heavy / Iterative

This cluster is where the experiment will be won or lost.

F6, F7, F9, and F10 are the right kinds of tasks for P-accumulated, but only if later steps depend on state that is revealed over time and not fully compressible into a single prompt without loss. If D/S get the full clean history every time, you stop measuring "persistent iterative context" and start measuring "how well can the harness summarize."

F8 is the weakest member here. A strong single-shot agent can often win a multi-file refactor if the prompt is clean and tests are good. It only becomes a real persistent-memory task if you add prior design constraints, a staged second failure, or both.

F2 also needs care. It is only context-heavy if the setup includes prior failed slim attempts, hard rules that must survive, or stakeholder constraints that are not all repeated in the task turn. Otherwise it is just a standalone design proposal.

## 4. Proposed additions (max 3)

### Fa. False Prior Override — direct pollution measurement

- Cluster: new
- Setup: 3-4 prior turns establish a plausible but wrong decision or fact, then bury a later correction in semantically similar discussion. Example shape: earlier turn says "Either pattern approved" or "library X cannot do Y"; later turn reverses it with evidence.
- Task: apply the current truth to a concrete review/spec/edit task without being told which prior statement is stale.
- Grading: binary leak check for the planted false fact, binary correctness on the actual task, plus a citation-to-turn requirement.
- Expected winner: D or S

Why non-redundant: this is the cleanest fixture for the pollution axis, and it gives you the "weak mode wins for the right reason" case that the current set lacks.

### Fb. Superseded Decision Under Semantic Masking — latest-decision retrieval, not just needle recall

- Cluster: C3/new
- Setup: 8-10 turns contain several similar design decisions, one superseding another late in the transcript. The distractors should be semantically close, not random filler.
- Task: apply the latest approved decision to a small target artifact and cite the deciding turn.
- Grading: exact latest-decision correctness, rejection of superseded decisions, and factual application to the artifact.
- Expected winner: P-accumulated

Why non-redundant: F7 is the simple version of this. This fixture is the realistic version. It tests the failure mode described in semantic-masking work rather than generic long-context recall.

### Fc. Mixed Investigation Trade-off — no clear winner by design

- Cluster: new
- Setup: moderate prior repo context plus one missing external fact that must be looked up from a primary source.
- Task: produce a short ADR/recommendation that must combine the internal context with one external, time-sensitive source.
- Grading: deterministic check for the internal constraint, live citation verification for the external fact, and a short quality rubric.
- Expected winner: none clearly; likely quality edges to P, cost edges to D/S

Why non-redundant: this prevents the decision tree from degenerating into "pick the modal winner." Real orchestration decisions often live in this mixed zone.

## 5. Proposed reductions

- Drop F1: it is a good harness smoke test, but a poor decision-theory fixture. It has near-zero memory demand, low cognitive demand, and an easy shell-level shortcut path. Keeping it in the core set will overweight a case that tells you almost nothing about D vs P vs S.
- No other drops. Everything else can be made high-signal by hardening the grader or preserving sequential information flow.

## 6. Grading hardening per fixture

- F1: move it out of the scored core set, or convert it into a hidden-variant smoke test only.
- F2: hidden invariants checklist; explicit preservation matrix; blind pairwise judging with order swap to reduce judge bias ([Zheng et al. 2023](https://papers.nips.cc/paper_files/paper/2023/file/91f18a1287b398d378ef22505bf41832-Paper-Datasets_and_Benchmarks.pdf), [Shi et al. 2025](https://arxiv.org/abs/2406.07791)).
- F3: severity-weighted precision/recall on issue IDs; penalize unmatched findings; hide the number of true issues.
- F4: oracle graph scoring on entities and edges; penalize invented structure; require file anchors.
- F5: URL liveness check, primary-source quota, claim-citation spot checks, and topic/date specificity.
- F6: builder-style sequential reveal only; no future errors in prompt; score both final success and turns-to-success.
- F7: unnamed task turn; latest-decision retrieval only; mandatory citation to prior turn; include at least one plausible wrong alternative.
- F8: hidden tests, no test edits, duplication-reduction metric, and minimal-change check on public behavior.
- F9: make at least three plausible root causes visible in the current file; only setup history should disambiguate the real one.
- F10: hidden unresolved-state checklist; one or two deliberately omitted items in the snapshot; stale-decoy tasks to catch blind snapshot copying.

At the suite level, I would also harden the open-ended graders this way:
- use swapped-order pairwise judging for close outputs
- keep answer length within a reasonable cap so verbosity is less rewarded
- prefer an LLM jury/panel over a single judge where budget allows, since multi-judge aggregation reduces intra-model bias at lower cost than one oversized judge ([Verga et al. 2024](https://arxiv.org/abs/2404.18796))

## 7. Final recommended set

- Count: 10
- Change list: drop F1; add Fa; modify F2/F3/F4/F5/F6/F7/F8/F9/F10 for harder grading and cleaner mode-strength preservation

If you want the smallest effective change, do exactly this:
1. Replace F1 with Fa.
2. Fold Fb's semantic-masking behavior into F7 instead of adding an 11th fixture.
3. Leave Fc for a follow-up only if pilot results show all pairwise mode wins are too clean and the trade-off boundary is still ambiguous.

That keeps wall-clock roughly flat while fixing the biggest blind spot: you currently test helpful memory much better than harmful memory.

## Sources

- Zheng et al. 2023, "Judging LLM-as-a-Judge" — https://papers.nips.cc/paper_files/paper/2023/file/91f18a1287b398d378ef22505bf41832-Paper-Datasets_and_Benchmarks.pdf
- Shi et al. 2025, "Judging the Judges: A Systematic Study of Position Bias in LLM-as-a-Judge" — https://arxiv.org/abs/2406.07791
- Shi & Penn 2025, "Semantic Masking in a Needle-in-a-haystack Test for Evaluating Large Language Model Long-Text Capabilities" — https://aclanthology.org/2025.wraicogs-1.2/
- Deng et al. 2024, "Investigating Data Contamination in Modern Benchmarks for Large Language Models" — https://aclanthology.org/2024.naacl-long.482/
- OpenAI GSM1k paper, NeurIPS 2024 — https://proceedings.neurips.cc/paper_files/paper/2024/file/53384f2090c6a5cac952c598fd67992f-Paper-Datasets_and_Benchmarks_Track.pdf
- Verga et al. 2024, "Replacing Judges with Juries" — https://arxiv.org/abs/2404.18796
