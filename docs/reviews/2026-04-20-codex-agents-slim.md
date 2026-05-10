# AGENTS.md Slimming Review

Verdict: REQUEST_REVISION

## Critical issues (🔴)

1. Lost hard rule during renumbering: the original explicit workaround ban is gone.
   - Original backup contains `14. **워크어라운드 금지 (HARD RULE)**` with the requirement to fix root causes instead of symptoms at `AGENTS.md.pre-slim.20260420-080813.bak:93`.
   - In the slimmed extraction, `Rule 14` now means the unrelated universal-user / multi-cross requirement at `docs/rules.md:89` and `docs/rules.md:90`.
   - I could not find any replacement rule in `docs/rules.md` carrying the original workaround-ban semantics. This makes the refactor non-lossless.

## High issues (🟡)

1. The new "매번 확인 — HARD RULE" checklist is not complete against the surviving hard rules.
   - The checklist now spans only 12 items in `AGENTS.md:5` through `AGENTS.md:20`.
   - Hard rules still present in extracted docs but absent from that checklist include:
     - Rule 6 user confirmation: `docs/rules.md:26`
     - Rule 15 report vs free-discussion boundary: `docs/rules.md:92`
     - Rule 16 dynamic orchestrator behavior: `docs/rules.md:99`
     - Rule 18 benchmark-first debugging: `docs/rules.md:105`
     - Rule 19 completion-report feasibility validation: `docs/rules.md:114`
     - Rule 20 sandbox isolation: `docs/rules.md:122`
   - Because the section is labeled as a mandatory per-action checklist, these omissions create an operational regression even though the full rules still exist elsewhere.

2. The aterm extraction is now an external, machine-specific dependency rather than a repo-local doc.
   - `AGENTS.md` points to `~/projects/aigentry-aterm/aterm-context.md` at `AGENTS.md:24`.
   - That file exists locally and the extraction itself is faithful at `/Users/duckyoungkim/projects/aigentry-aterm/aterm-context.md:1`, but it is outside this repository and tied to one home-directory layout.
   - That weakens pointer portability, makes review/versioning cross-repo, and no longer matches the original stated shape of the refactor (`docs/aterm-context.md` inside orchestrator).

## Medium issues (🟢)

1. `docs/sawp.md` has a copy-edit regression in the analyst vs architect boundary sentence.
   - Original wording is complete at `AGENTS.md.pre-slim.20260420-080813.bak:51`.
   - Extracted wording ends mid-thought at `docs/sawp.md:41`.
   - This is not a policy loss on its own, but it is a degraded reproduction of the source text.

2. This is no longer a pure slimming/extraction change; it also introduces a new hard rule.
   - The slimmed checklist includes `Rule 26` at `AGENTS.md:20`.
   - The extracted body defines `Rule 26. Cross-OS Abstraction Mandate` at `docs/rules.md:159`.
   - I did not find a matching rule in the 276-line backup, so this refactor now mixes extraction with new policy.

## Token verification

- Measured with `wc -w`:
  - `AGENTS.md.pre-slim.20260420-080813.bak`: 3648 words
  - `AGENTS.md`: 890 words
  - `docs/rules.md`: 1633 words
  - `docs/sawp.md`: 351 words
  - `/Users/duckyoungkim/projects/aigentry-aterm/aterm-context.md`: 491 words
  - `CLAUDE.md`: 100 words
- Repo heuristic (`wc -w × 1.3`) used in the motivation is internally consistent:
  - pre-slim AGENTS only: `3648 × 1.3 = 4742.4`
  - slim AGENTS only: `890 × 1.3 = 1157.0`
  - reduction: 75.6%
- For Claude Code specifically, the startup-load story is different:
  - This repo uses `CLAUDE.md` to import `AGENTS.md` at `CLAUDE.md:1`.
  - With the current layout, estimated startup payload is roughly:
    - before: `(CLAUDE.md 100 + old AGENTS 3648) × 1.3 = 4872.4`
    - after: `(CLAUDE.md 100 + new AGENTS 890) × 1.3 = 1287.0`
    - reduction: 73.6%
  - `docs/rules.md`, `docs/sawp.md`, and the aterm context file are not imported with `@...`, so under Claude Code they remain on-demand rather than launch-loaded.
- I could not produce model-exact tokenizer counts locally because no GPT/Claude tokenizer library was available in this environment; the measurements above are exact word counts plus the repository's stated estimation formula.

## Recommendations

1. Restore the dropped workaround-ban rule before approving the slimming refactor. Either reintroduce it as its own numbered rule or merge it explicitly into the evidence/root-cause rules without ambiguity.
2. Decide whether the checklist is intended to be exhaustive. If yes, add the missing hard-rule entries. If no, relabel it as a "core pre-delegation checklist" instead of "매번 확인 — HARD RULE".
3. Finish the aterm move cleanly:
   - either keep the file repo-local until the cross-repo contract is stable, or
   - document the sibling-repo dependency explicitly and avoid `~`-based, machine-specific pointers in team-shared instructions.
4. Fix the truncated SAWP sentence and keep the extraction text mechanically identical where the review goal is semantic preservation.
5. Separate "slimming extraction" from "new policy introduction". If Rule 26 is intentional, land it in a dedicated change with its own rationale.

## Notes

- Duplicated numbering from the original backup is mostly resolved cleanly in `docs/rules.md`:
  - old duplicate `10` became `Rule 10` + `Rule 10-1`
  - old out-of-order `14/15/16/18/19/20/21/22/24/25` are now normalized
- `docs/sawp.md` preserves the actual SAWP envelope block verbatim at `docs/sawp.md:7`.
- The aterm extraction content is substantively preserved in the external file; the main concern is pointer portability, not content fidelity.
