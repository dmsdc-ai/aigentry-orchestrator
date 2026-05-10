# Open Questions Tracker

Canonical list of open research questions surfaced during the Rule 4 Mode Selection deliberation (ADR `docs/adr/2026-04-22-rule-4-mode-selection.md`) and adjacent CLI reset research.

- **Format**: each question is a distinct section. Status ∈ `open | in-progress | resolved | superseded`.
- **Owners**: TBD entries are filled when a session takes the follow-up.
- **Resolution discipline**: closing a question requires evidence (commit hash, report path, empirical test with seed/log).

---

## Q1 — Claude Code auto-compact exact threshold (SUPERSEDED)

- **Topic**: cross-CLI, Preuse-compact selection (Rule 4-A Step 4).
- **Status**: superseded — 2026-04-26.
- **Source**: dustcraw report `~/projects/aigentry-orchestrator/docs/research/2026-04-21-cli-context-reset-compare.md` (commit `e633566`).
- **Why superseded**: V4 probe (`docs/research/2026-04-26-q1-claude-threshold-runs/raw/probe_V4_s42.{csv,log,jsonl}`) showed `claude -p --resume` does not trigger auto-compact at cumulative input ≥753,828 tokens. The Phase 4 trial driver is `-p` (verified at `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:229`); under that driver no auto-compact threshold exists to be measured.
- **Replacement prereq**: P4-pre-1 (Substitute-compact summarizer spec) and P4-pre-2 (Phase 3 transcript-size distribution pull) — see ADR `docs/adr/2026-04-26-q1-prereq-redesign.md` §3.
- **Phase 4c arm semantic**: see same ADR §4 (transcript-size cuts replace threshold anchors).
- **Re-open trigger**: if Phase 4 introduces an interactive REPL driver (e.g., `script(1)` PTY wrapper), re-instantiate Q1 scoped to the REPL slice.

## Q2 — Codex `threshold_tokens` × `context_window` interaction

- **Topic**: cross-CLI portability of Preuse-compact.
- **Status**: open.
- **Source**: CLI compare report (commit `e633566`) + Codex Round 2 position noting Codex auto-compact is configurable but semantics differ from Claude.
- **Why it matters**: Rule 4-A Step 4's Layer 2 portability depends on a uniform token-accounting primitive. If Codex's `threshold_tokens` counts differently (e.g., only user turns vs. full transcript), a single Preuse-compact policy cannot be shared across CLIs.
- **Resolution plan**: (1) read Codex source / docs for exact counting rule; (2) run matched-prompt comparison between Codex and Claude to measure ratio of tokens counted; (3) document conversion factor or declare non-portable.
- **Owner**: TBD (dustcraw for upstream spec, analyst for matched-run data).
- **Success criterion**: documented mapping table between Claude token count and Codex `threshold_tokens`, or formal declaration that Preuse-compact is Layer-1 only.

## Q3 — Gemini `/clear` semantics (RESOLVED)

- **Topic**: cross-CLI reset primitive.
- **Status**: resolved — 2026-04-21.
- **Evidence**: v0.38.2 empirical test (tooltip inspection + confirmed by orchestrator session), captured in dustcraw CLI compare research.
- **Version pin**: **v0.38.2** current behavior. Earlier versions behaved as "display-only"; later versions not yet tested. Re-verify on Gemini version bump.
- **Supersedes**: dustcraw report `2026-04-21-cli-context-reset-compare.md` §gemini — the "display-only" characterization is now outdated for v0.38.2+.
- **Resolution owner**: orchestrator (verification signed off).
- **Follow-up trigger**: any Gemini minor/major version bump — re-test before trusting prior finding.

## Q4 — Cross-CLI uniform token counter primitive

- **Topic**: Layer 2 coordination (Rule 4-A Step 1 Capability Gate).
- **Status**: open.
- **Source**: deliberation Round 2 (Codex `~/.telepty/shared/dbe31b08…`) — raised as prerequisite for any cross-CLI mode policy.
- **Why it matters**: without a common accounting, Layer 2 D fallback can advise thresholds that mean different things on Claude vs. Codex vs. Gemini. Compounds Q1 and Q2.
- **Resolution plan**: (1) inventory each CLI's token accounting (encoder, what is counted, when); (2) define a neutral primitive (e.g., tokenized prompt + completion pair) and a per-CLI adapter; (3) publish conversion table.
- **Owner**: TBD (dustcraw for upstream, architect for primitive design, analyst for measurement).
- **Success criterion**: reusable primitive named and demonstrated across all three CLIs with <10% variance on a shared reference transcript.

## Q5 — Partial compaction (Claude-only) vs Rule 4-0 §2 cross-everything

- **Topic**: Rule 4-0 portability tension.
- **Status**: open.
- **Source**: ADR `2026-04-22-rule-4-mode-selection.md` §6 (Open Questions).
- **Why it matters**: Claude offers partial/progressive compaction that is not available on Codex/Gemini. If Preuse-compact is tuned to leverage partial compaction, it becomes Layer-1 only — which is fine under Rule 4-0 §Layer separation, but must be named explicitly to avoid drift.
- **Resolution plan**: decide at Phase 4 design review whether Preuse-compact is (a) Layer-1 only by policy, (b) defined at the LCD of all three CLIs, or (c) forked per-layer.
- **Owner**: TBD (architect at Phase 4 kickoff).
- **Success criterion**: decision recorded in Phase 4 plan + reflected in Rule 4-A Step 5 if Layer 1 becomes S-only for this mode.

## Q6 — CLAUDE.md / GEMINI.md re-load cost on `/clear`

- **Topic**: per-session `/clear` overhead.
- **Status**: open.
- **Source**: CLI compare research (commit `e633566`) — noted but not quantified.
- **Why it matters**: Preuse-clear at task boundary (Rule 4-A Step 4) pays a cost equal to CLAUDE.md + AGENTS.md re-ingestion. If that cost is high relative to task size, Preuse-clear may be net-negative for small tasks.
- **Resolution plan**: measure token cost of CLAUDE.md + AGENTS.md + docs/rules.md for each CLI; compute break-even task size.
- **Owner**: TBD (analyst — reuse Phase 3 grader harness if applicable).
- **Success criterion**: break-even curve published (task size × context-doc size → net benefit threshold).

## Q7a — Auto-compact disablement per CLI (`-p` slice) (RESOLVED)

- **Topic**: reproducibility of Phase 4 replication under the `-p` trial driver.
- **Status**: resolved — 2026-04-26.
- **Evidence**: V4 probe (seed=42, V4 = 4-prompt template ≈180k tokens/turn). Cumulative input reached 753,828 tokens (probe.csv: turn 1 in=259,417, turn 2 in=494,411). Auto-compact marker did not appear; cap-stop was the probe harness's own `cap=300000` (probe.log:4 — `[run] PROBE cap reached: cum=753828 > 300000 — stopping`). Independently corroborated by Phase 3 dataset where compact.detected=0/399 across all four modes (analyst report `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md:58`).
- **Conclusion**: under `claude -p [--resume]`, auto-compact does not fire at workloads up to ≥753k cumulative input tokens. "Disablement" is moot for this slice — there is nothing to disable.
- **Version pin**: `claude` CLI version captured in `metrics.json.cli_versions.claude` of the V4 probe trial (`bin/exec-mode-experiment.sh:172`). Analyst should extract and record here on adoption.
- **Supersedes**: dustcraw "unknown → T4 empirical" mark for Claude in the `-p` slice.
- **Re-open trigger**: any Claude CLI minor/major version bump — re-test before trusting prior finding.
- **Resolved-by**: ADR `docs/adr/2026-04-26-q1-prereq-redesign.md` §M4.

## Q7b — Auto-compact disablement per CLI (interactive REPL slice)

- **Topic**: reproducibility for operator-facing interactive REPL usage outside trials.
- **Status**: open.
- **Source**: original Q7 (now Q7a + Q7b split) and CLI compare research (commit `e633566`).
- **Why it matters**: trials use `-p` so Q7b does not block Phase 4. But operator-facing guidance (and any future interactive-REPL trial slice) needs to know whether REPL auto-compact is disable-able per CLI.
- **Resolution plan**: original Q7 plan inherited verbatim — (1) dustcraw survey of per-CLI flags / env vars for auto-compact disablement; (2) builder verification on Claude REPL; (3) per-CLI "can-disable: yes/no" table with flag names or workarounds.
- **Owner**: TBD (dustcraw upstream, builder verification).
- **Success criterion**: REPL-slice "can-disable: yes/no" table; if any major CLI cannot disable, document the operator workaround.
- **Non-blocking for**: Phase 4 (trial harness is `-p`).

## Q8 — Codex `/clear` vs `/new` semantics

- **Topic**: reset primitive selection on Codex.
- **Status**: open.
- **Source**: CLI compare research (commit `e633566`) — distinguishes `/clear` (clear transcript, keep session file) from `/new` (new session file).
- **Why it matters**: Preuse-clear on Codex could mean two different things; Rule 4-A currently treats Preuse-clear as a single operation. If the two primitives have different pollution behavior (e.g., `/clear` still leaks via cached tool state), Rule 4-A needs refinement.
- **Resolution plan**: run matched-context probe on Codex after `/clear` vs. `/new` and compare output divergence on a known follow-up prompt.
- **Owner**: TBD (analyst on Codex, using exec-mode grader harness).
- **Success criterion**: documented divergence (or equivalence) + decision on which primitive Preuse-clear maps to on Codex.

---

## Change log

- **2026-04-23** — tracker initialized by architect session `E-architect-rule4` for ADR `2026-04-22-rule-4-mode-selection.md`. Q1, Q2, Q4, Q5, Q6, Q7, Q8 open. Q3 resolved (Gemini v0.38.2).
- **2026-04-26** — Q1 superseded; Q7 split into Q7a (RESOLVED, `-p` slice) and Q7b (OPEN, REPL slice). Driver: ADR `docs/adr/2026-04-26-q1-prereq-redesign.md`. Evidence: V4 probe artifacts in `docs/research/2026-04-26-q1-claude-threshold-runs/raw/`.

## References

- ADR: `docs/adr/2026-04-22-rule-4-mode-selection.md`.
- CLI compare research: `docs/research/2026-04-21-cli-context-reset-compare.md` (commit `e633566`).
- Phase 3 analyst: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md` (commit `472cc9f`).
- Phase 3 Codex cross-check: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3-codex.md` (commit `9c36973`).
- H8 F10 regrade: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-h8-f10-regrade.md` (commit `f5fdd3d`).
- Phase 4 plan: `docs/plans/2026-04-22-phase4-plan.md`.
