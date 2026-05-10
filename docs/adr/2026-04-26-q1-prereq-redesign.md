# ADR 2026-04-26: Q1 Prereq Redesign — Driver-Methodology Reframe of Phase 4a/4c

- **Status**: Accepted (rev2) — 2026-04-26
- **Date**: 2026-04-26 (rev1) / 2026-04-26 (rev2 — review-loop iter 1) / 2026-04-26 (Accepted, user gate α)
- **Author**: architect session `Q1-architect-redesign` (claude)
- **Reviewers (rev1 → rev2)**: Codex (`Q1-codex-reviewer`, ACCEPT-IF → ACCEPT iter-2) + Gemini (`Q1-gemini-reviewer`, ACCEPT-IF → ACCEPT iter-2). Reviews at `docs/adr/2026-04-26-q1-prereq-redesign-review-codex.md` (rev1 + §5 iter-2 ACCEPT) + `docs/adr/2026-04-26-q1-prereq-redesign-review-gemini.md` (rev1 + §6 iter-2 ACCEPT). See §11 Revision history for rev2 changes.
- **User approval**: orchestrator dispatch α (2026-04-26) — final acceptance gate cleared.
- **Predecessor ADRs**: `docs/adr/2026-04-22-rule-4-mode-selection.md` (Rule 4-0 / Rule 4-A — Accepted, Narrow Lock)
- **Predecessor plans**: `docs/plans/2026-04-22-phase4-plan.md` (Phase 4 — Draft)
- **Sub-spec gate**: `~/projects/aigentry-architect/docs/spec-q1-prereq-redesign-sub.md` (APPROVED via shared `1d43e69d…`)
- **Cross-project ADR write authorized**: orchestrator dispatch `8eebafe7…` + APPROVED reply `1d43e69d…` (architect AGENTS.md §5.2 boundary explicitly cleared)
- **Decision type**: two-way (revisable on Phase 4 data)
- **Scope**: ecosystem (Phase 4 plan + open-questions tracker + Rule 4 successor)
- **Tier**: T2 (ADR + ecosystem scope)

---

## 1. Context

### 1.1 Trigger

Phase 3 (#329 Track E27) shipped Rule 4 (Narrow Lock, Accepted 2026-04-26) and queued Phase 4 (1,600 trials). Phase 4c plans a Preuse-compact arm sweep at four thresholds T1<T2<T3<T4 anchored on the Claude `claude` CLI auto-compact boundary. Tracker Q1 ("Claude Code auto-compact exact threshold") was registered as a Phase 4a prerequisite on the assumption that an auto-compact threshold exists *under the Phase 3/4 trial driver* and can therefore anchor the four arms.

A builder probe (`Q1-builder-instrument`, ABORTED 2026-04-26) ran a `claude -p --resume` chained driver at the largest workload (V4: 4-prompt template ≈ 180k tokens/turn, seed=42). Result:

- **Turn 1**: `input_tokens=259,417` (`cache_create=243,207`, `cache_read=16,204`).
- **Turn 2**: `input_tokens=494,411` (`cache_create=234,994`, `cache_read=259,411`).
- **Cumulative input**: 753,828 tokens.
- **Auto-compact marker**: NEVER appeared. Run cap-stopped at turn 2.

Cap-stop reason is unambiguous from the probe log:

> `[run] PROBE cap reached: cum=753828 > 300000 — stopping`
> (`docs/research/2026-04-26-q1-claude-threshold-runs/raw/probe_V4_s42.log:4`)

The stop is the **probe harness's own cumulative-input cap of 300,000 tokens**, not a runtime hard limit, billing limit, or auto-compact firing. The harness stopped *because* compact had still not fired well past the cap budget; the probe author took that as sufficient evidence to abort and re-evaluate Q1.

Cache_read=259,411 on turn 2 confirms `--resume` replays the full prior transcript (not a delta), so the absence of compact is not a data-collection artifact — the model genuinely sees ≥753k cumulative input across turns and emits no auto-compact event.

### 1.2 Why this is a redesign, not a Q1 status update

Q1 as originally framed assumes the four Preuse-compact arms will be *positioned around a measured boundary*. If no boundary fires under our driver, the arms have nothing to be positioned around. Three downstream artifacts therefore need consistency edits:

1. **Q1 itself** — premise invalidated; tracker entry must change.
2. **Phase 4c plan** — arm semantics need a new variable to sweep.
3. **Q7** — partly resolved by V4 probe data; needs to be split.

A Phase 3 re-analysis (M5) is also in scope because the Pacc accumulation decay was at risk of being attributed to a phenomenon (auto-compact) that did not occur in the dataset.

---

## 2. Investigation — M1–M5 (each: method, finding, decision)

### M1 — What driver did Phase 3 trials use?

**Method**: read the runner scripts and confirm the `claude` invocation per mode. Files inspected:

- `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh` (top-level per-trial driver)
- `~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh` (shared helpers)

(Note: orchestrator dispatch ref pointed at `~/projects/aigentry-devkit/exec-mode/`; that path does not exist in the repo. Actual runner scripts are in `bin/`. Used the latter throughout.)

**Finding** — *all 4 modes use `claude --print` (= `-p` non-interactive)*:

- The default Stage 1 invocation is constructed in `bin/exec-mode-experiment.sh:229`:
  > `local default_cmd="claude --print --output-format stream-json --verbose --disable-slash-commands --model ${EXEC_MODE_MODEL:-claude-opus-4-7}"`
- **D** (`harness_stage1_live_D`, lines 312–321): single `--print` with `setup_history.md` + `task_prompt.md` on stdin.
- **S** (`harness_stage1_live_S`, lines 323–329): explicitly delegates to `harness_stage1_live_D` ("Same composition as D for now"). No subagent fork in the live path; the differential is in cache/plan state during Phase 2 only.
- **Pfresh** (`harness_stage1_live_Pfresh`, lines 335–388): `--print` per warmup turn, with `--resume <session_id>` chained to accumulate session history; final task turn also `--print --resume`.
- **Pacc** (`harness_stage1_live_Pacc`, lines 393–417): pos=1 is `--print` cold; pos>1 is `--print --resume <prior_sid>` against the pos=1 session.
- **Stage 2 probes** (`execmode::stage2_probe_subprocess`, `bin/lib/exec-mode-lib.sh:395–462`): `EXECMODE_STAGE2_CMD` defaults to `claude --print` (line 449), invoked under `env -i` scrub.

In addition, `--disable-slash-commands` is set on every Stage 1 invocation (line 229). This is decisive for M3 below: even if a session were left interactive, the trial harness explicitly forbids `/compact` and `/clear` slash commands.

**Decision**: **M1-H1 CONFIRMED**. Phase 3 was `-p`-only with `--resume` for cross-turn chaining (Pfresh) and cross-position chaining (Pacc). The Phase 3 dataset therefore already reflects "no auto-compact" implicitly. Independent confirmation in the analyst report (M5).

---

### M2 — Will Phase 4 use `-p` or interactive REPL?

**Method**: read `docs/plans/2026-04-22-phase4-plan.md` for any explicit driver/harness change vs Phase 3.

**Finding**:

- §2.1 ("Replication arms (re-run Phase 3 modes, 20 seeds)", lines 25–34) frames Phase 4b as *replication* of Phase 3 modes. By construction, this inherits the Phase 3 driver = `-p`.
- §2.2 ("Preuse arms (new modes, 10 seeds)", lines 36–46) introduces Preuse-clear and Preuse-compact (T1–T4) but **does not specify a driver change** — no PTY wrapper, no `script(1)`, no aterm-mediated REPL, no different runner script.
- §3 sequencing (lines 64–86) makes Phase 4b conditional on Q7 ("auto-compact disablement") confirming "reproducibility for D/S/Pfresh/Pacc". Under M1's verified driver, the relevant reproducibility property is "auto-compact does not fire under `-p`" — already empirically true (M4 below). Q7's framing in the plan is strictly stronger than what the trial driver actually requires.
- §5 ("Prerequisite resolutions (tracker)", lines 100–108) lists Q1 as needed "to locate T1–T4 for Preuse-compact" with the resolution route "anchor T2–T3 around the measured threshold; T1 below, T4 above". This anchor logic depends on M1-H1 being false (i.e., the driver hits a threshold) — under the actual `-p` driver it cannot be applied as written.
- §10 ("Ownership", lines 162–168): "Runner session: TBD (propose aigentry-devkit runner; claim at kickoff)". The default candidate runner is the same `bin/exec-mode-experiment.sh` audited in M1.

**Decision**: **M2-H2 CONFIRMED**. Phase 4 inherits the Phase 3 `-p` driver implicitly. No interactive REPL or PTY harness is planned. The implication is that **Q1 is moot for Phase 4 as currently scoped** — there is no auto-compact boundary to anchor T1–T4 against, because the boundary does not fire under the inherited driver.

---

### M3 — Preuse-compact arm semantic re-definition

**Method**: cross-reference Rule 4-A Step 4 intent (`docs/adr/2026-04-22-rule-4-mode-selection.md` §2.2 lines 96–101) against the actual driver primitives available to the trial harness, then evaluate three options.

**Finding — three structural facts the original arm semantic ignored**:

1. **Slash commands are disabled in trials**. `--disable-slash-commands` (`bin/exec-mode-experiment.sh:229`) means even an interactive REPL would refuse `/compact`. So "Preuse-compact" cannot be implemented as "user types `/compact` between turns" inside the existing Phase 3 harness — it must be a *programmatic* substitute.
2. **`--resume` replays the full transcript**. The V4 probe shows `cache_read=259,411` on turn 2 (probe csv line 2). So under `-p --resume`, the agent's effective context grows monotonically with cumulative input; the only way to *shrink* it is to drop `--resume` (= start a new session) or to programmatically rewrite the resumed session's history (no public CLI primitive for this).
3. **Phase 3 had compact rate 0/399**. The analyst report (`docs/reports/2026-04-21-exec-mode-analyst-phase3.md:58`) records: "compact.detected=true count across all 399 trials: 0. Compact rate per mode … D 0.000, Pfresh 0.000, Pacc 0.000, S 0.000. The 200K context cap (spec §10 risk row 1) did not bind in this pilot." Combined with V4's 753k cumulative no-fire, this is a stronger statement than "we did not measure auto-compact" — it is "auto-compact is de facto inert in our experimental envelope".

**Three candidate arm semantics**:

- **Option A — 4 transcript-size cuts (compact-by-substitution)**. Define each arm at a cumulative-input token boundary (e.g., 10k / 50k / 100k / 150k). When cumulative input crosses the arm's boundary mid-Pacc-chain, the next turn drops `--resume` and re-feeds a *programmatically compacted* prompt (e.g., a summary built deterministically by the harness). Rule 4-A Step 4 intent ("compact-then-resume vs fresh-D") maps cleanly: the arm answers "at what transcript size does substitute-compact-then-fresh-resume beat plain fresh-D".
- **Option B — 4 turn-count cuts**. Substitute-compact every K turns for K ∈ {5, 10, 20, 40}. Simpler to implement, but **conflates turn count with token volume** when fixtures vary in prompt size (Phase 3 fixtures span ~10k–180k tokens per turn; see V4 probe csv). A turn-count arm then measures "how often we reset" rather than "what context volume triggers benefit", which is the Rule 4-A intent.
- **Option C — Drop the sweep, keep one Preuse-compact arm + Preuse-clear**. Tests whether *any* substitute-compact beats fresh-D, ignoring the volume question. Cheapest (saves 300 trials) but answers a strictly weaker question — Phase 4 cannot graduate Rule 4-0 to Full Lock without per-volume threshold data.

**Trade-off matrix**:

| Option | Maps to Rule 4-A intent | Trials | Confound risk | Implementation cost |
|---|---|---:|---|---|
| A (4 transcript-size cuts) | Yes — directly tests volume-dependence | 400 (4 × 10 fix × 10 seeds) | Low: cuts are token-deterministic | Medium: ≈180–260 LOC† |
| B (4 turn-count cuts) | Partial — proxies volume via turns | 400 | High: per-fixture token/turn varies ≈18× (e.g., Fa ≈10k vs F-large ≈180k) | Low: ≈60–90 LOC reset-only† |
| C (1 Preuse-compact arm + Preuse-clear) | No — answers binary "any benefit" only | 200 | N/A | Low |

† **Codex review §2 ¶4 LOC correction**: B's "Low" cost holds only if B is reset-only or turn-counter proxy. If B uses the same substitute summarizer as A, B is ≈140–220 LOC (vs A's ≈180–260 LOC), making A's *incremental* cost over B-with-summarizer only ≈30–50 LOC. Cost is therefore not a meaningful tiebreaker between A and B-with-summarizer; the decisive factor remains the confound risk in B's column. (Evidence: `docs/adr/2026-04-26-q1-prereq-redesign-review-codex.md:19`.)

**Recommendation — Option A**, with two sub-decisions:

1. **Cut grid (deterministic fallback per sub-spec R1)**: 10k / 50k / 100k / 150k cumulative input tokens. Marked `TBD-percentile-anchor` pending an analyst pull of Phase 3 transcript-size distribution; if percentile-anchored values land before Phase 4c kickoff, swap them in.
2. **"Substitute-compact" definition**: harness-controlled deterministic summarizer (e.g., concatenate `setup_history.md` excerpt + last K turns' user prompts + last assistant turn's final paragraph). Spec the summarizer in the Phase 4 plan revision so two implementations would converge byte-equally; do not call out to a model for the summary (would add a confound).

**Why not B or C**:

- B is rejected primarily on confound: at Phase 3 fixture variance (Fa vs F4 vs F10 prompt sizes differ by ≈18×), a "compact every 10 turns" arm visits four wildly different cumulative-input regimes per fixture, so the threshold sweep no longer measures threshold.
- C is rejected because Rule 4-0 → Full Lock promotion (`docs/adr/2026-04-22-rule-4-mode-selection.md` §5) requires "Phase 4c Preuse-compact best-threshold beats Phase 3 baseline Pacc on the same fixtures by a pre-declared margin". A single-arm Preuse-compact has no "best-threshold" to report.

**Decision**: **M3-H3 CONFIRMED with refinement**. Recommend Option A (4 transcript-size cuts) over Option B/C. Plan diff enumerated in §4.5.

---

### M4 — Q7 implication (auto-compact disable per CLI)

**Method**: cross-reference the V4 probe (csv + log) against Q7's tracker entry (`docs/research/open-questions-tracker.md:72–80`) and evaluate whether Q7 should split.

**Finding**:

- Q7 today: "auto-compact disablement per CLI". Resolution plan: dustcraw upstream survey + builder flag verification. Status: open.
- V4 probe is direct evidence on the **`-p` slice** of Q7: under `claude -p --resume` chained, auto-compact does not fire at cumulative input ≥753k. Cap-stop reason is the harness's own `cap=300000` (probe.log:4), unambiguously *not* an auto-compact event, runtime hard limit, or billing cap. So in `-p` mode, "disablement" is *moot* — there is nothing to disable.
- The **interactive REPL slice** (`claude` without `-p`, with `/compact` and similar commands enabled) is unverified. The dustcraw T1 survey marked Claude as `unknown → T4 empirical`; the empirical T4 has not been run for the REPL slice. The trial harness itself disables slash commands (M1, M3 finding 1), but the broader Q7 question covers REPL operator usage outside trials.
- The Q3 precedent (Gemini `/clear` v0.38.2, see open-questions-tracker `## Q3` lines 31–39) is instructive: the tracker pins resolutions to a CLI version. A Q7a resolution should similarly pin to the `claude` CLI version captured in `metrics.json.cli_versions.claude` for the V4 probe (recorded by `bin/exec-mode-experiment.sh:172` `capture_cli_version claude`).

**Residual ambiguity (sub-spec R2)**: with `cap=300000` as the documented stop reason, R2 collapses — there is no remaining ambiguity about whether cap-stop was a billing/runtime event. The probe.log line 4 disambiguates fully. M4-H4 is therefore confirmed cleanly (not "RESOLVED-WITH-CAVEAT" as the sub-spec hedged) for the `-p` slice. The only remaining caveat is that the V4 probe was a single workload (V4 only) at a single seed (42); a 1-shot follow-up at a smaller workload (V1/V2) would harden the claim, but is not blocking for this ADR.

**Decision**: **M4-H4 CONFIRMED — split Q7**.

- **Q7a (`-p` slice)**: RESOLVED. Auto-compact does not fire under `claude -p [--resume]` at workloads up to ≥753k cumulative input tokens; "disablement" is therefore moot for this slice. Pin: `claude` CLI version recorded in V4 probe `cli_versions.claude` (analyst should extract from probe artifacts).
- **Q7b (interactive REPL slice)**: OPEN. Original Q7 resolution route (dustcraw flag survey + builder verification) carries forward but applies only to REPL.

Tracker patches enumerated in §6.

---

### M5 — Was Phase 3 actually noise-clean? (analyst-report attribution)

**Method**: read the analyst report (`docs/reports/2026-04-21-exec-mode-analyst-phase3.md`) §6 "Pacc accumulation decay" and adjacent attribution text, and check whether auto-compact was cited as a contributing cause of Pacc decay.

**Finding**:

- Compact-rate observation, line 58 (verbatim): *"`compact.detected=true` count across all 399 trials: 0. Compact rate per mode (via analyzer `compact_rate_table`): D 0.000, Pfresh 0.000, Pacc 0.000, S 0.000. This matches all four runner reports. The 200K context cap (spec §10 risk row 1) did not bind in this pilot."*
- §6 Pacc decay attribution (lines 207–258): the position-stratified table (§6.1, lines 215–224) shows the 0.490 → 0.000 decay across pos=1 → pos=8. §6.2 ("Decay interpretation + pos=10 rebound diagnosis", lines 228–249) attributes the apparent decay to **structural Pacc unsuitability for context-heavy sustained work**, with the pos=10 rebound traced to a *fixture-mix artifact* (Fa appearing in pos=10 slot for 3/10 sessions; lines 234–247). §6.3 (lines 251–253) notes "claude `--resume` appears to be cache-efficient per Pacc runner report" — implicitly compatible with the no-compact observation. §6.4 (lines 255–257) attributes pollution and loss to position-independent floors.
- The string "auto-compact" / "compact drift" / similar does **not** appear in the Pacc decay attribution. The analyst's section 4 baseline-checks (lines 56–62) explicitly registered the 0/399 compact rate as a clean dataset property, not a phenomenon driving any downstream finding.

**Decision**: **M5-H5 FALSIFIED**. The analyst report did *not* attribute Pacc decay to auto-compact. No corrigendum required. Recommended: a one-paragraph caveat note in a future analyst replication report stating that V4 probe extends the "no auto-compact under `-p`" finding from Phase 3's 200k spec cap to ≥753k empirical cumulative input — confirming and broadening the §4.1 baseline-check, but not changing any §5/§6/§7 conclusion.

---

## 3. Updated Phase 4a prereq list

The Phase 4a prereq block in `docs/plans/2026-04-22-phase4-plan.md` §5 currently lists Q1 (blocking), Q2 (deferred), Q7 (blocking). Updated list:

| Prereq | Old status | New status | Rationale |
|---|---|---|---|
| **Q1** (Claude auto-compact exact threshold) | Blocking — needed to anchor T1–T4 | **SUPERSEDED** by this ADR | Under the trial driver (`-p`), no boundary fires; Phase 4c arm semantic moves from threshold-anchored to transcript-size-cut (M3, §4 below). |
| **Q2** (Codex `threshold_tokens` × `context_window`) | Deferred (Claude-only Narrow Lock) | Unchanged — deferred | No new evidence; Rule 4-0 keeps Phase 4 Claude-only. |
| **Q7** (auto-compact disablement per CLI) | Blocking | **Q7a RESOLVED, Q7b deferred** | `-p` slice resolved by V4 probe (M4); REPL slice not on Phase 4 critical path because trial harness uses `-p` (M1). |
| **NEW: P4-pre-1** (Substitute-compact summarizer spec) | — | **Blocking** for Phase 4c | Option A (M3) requires a deterministic, harness-implementable substitute-compact primitive specified before the four arms can run. Owner: architect (this ADR is a stub; full spec in Phase 4 plan revision). |
| **NEW: P4-pre-2** (Phase 3 transcript-size distribution pull) | — | **Soft prereq** for Phase 4c | If analyst publishes the Phase 3 cumulative-input distribution per (mode, fixture), the four-cut grid in §4 should be percentile-anchored (e.g., 25/50/75/90 percentiles of Pacc-pos≥3 distribution). Otherwise deterministic 10k/50k/100k/150k stands. Owner: analyst. |

Q4, Q5, Q6, Q8 are unchanged from the existing plan §5: informational, non-blocking for Phase 4 Claude-only.

---

## 4. Updated Phase 4c arm semantics

### 4.1 Replacement arm definition

Replace the §2.2 Preuse-compact T1–T4 arms with **Preuse-substitute-compact at four per-segment cumulative-input cuts**:

| Arm | `cut_tokens` (default; supersede with percentile if available) | Operational semantic (per §4.6 `substitute-compact-v1`) |
|---|---:|---|
| Preuse-substitute-compact-C1 | 10,000 | Before each Pacc position `p>1`, compute `segment_input_tokens = sum(metrics.cost.usage_buckets.input_tokens)` for completed positions from `segment_start_position` through `p-1`. If `≥ cut_tokens`: invoke `build_substitute_compact_stdin(manifest)` (§4.6), run **cold `claude -p`** (no `--resume`), extract new session_id from stage1 jsonl, **overwrite `chain_state.session_id`**, and set `segment_start_position=p` for later positions. If not crossed: run existing Pacc `claude -p --resume <prior_sid>` unchanged. |
| Preuse-substitute-compact-C2 | 50,000 | Same protocol, `cut_tokens=50_000`. |
| Preuse-substitute-compact-C3 | 100,000 | Same protocol, `cut_tokens=100_000`. |
| Preuse-substitute-compact-C4 | 150,000 | Same protocol, `cut_tokens=150_000`. |

**Boundary is per-segment, not global** (per Codex review §2 ¶2 + §3 bullet 2, `…review-codex.md:15,27`). Crossing the cut once does not force every subsequent position to compact; instead `segment_start_position` advances to the position that triggered the compact, and the next compact only fires when `segment_input_tokens` accumulated from *that* position again crosses `cut_tokens`. This keeps the arm semantic interpretable per-segment rather than degenerating to "compact every position after the first crossing".

`build_substitute_compact_stdin(manifest)` is normatively specified in §4.6 (`substitute-compact-v1`), adopted verbatim from Codex review §4. No model call inside the summarizer; no slash commands required (compatible with the harness's `--disable-slash-commands` at `bin/exec-mode-experiment.sh:229`).

### 4.2 Preuse-clear (unchanged)

Preuse-clear arm semantics in plan §2.2 are unaffected by this ADR. Reset semantics on Pacc chain boundary are independent of the auto-compact question.

### 4.3 Variable renamed

In Rule 4-A Step 4 ("Preuse Selection") and the Phase 4 plan §2.2 / §6, replace "Preuse-compact" with "Preuse-substitute-compact" everywhere the *trial-harness primitive* is meant. The user-facing Rule 4-A vocabulary may keep "Preuse-compact" for production guidance, with a footnote that the trial harness uses substitute-compact because slash commands are disabled in the harness (`--disable-slash-commands` per `bin/exec-mode-experiment.sh:229`). This split avoids the user-vs-trial semantic conflation that produced the Q1 mis-prereq.

### 4.4 Best-threshold reporting (Phase 4d)

Phase 4d analyst output should publish a per-arm quality-vs-cost frontier and select the arm that maximizes (Phase 3 baseline Pacc quality at matched cumulative input) − (arm quality). Phase 4 plan §7 success criterion 2 is unchanged in shape; the substantive change is "best-threshold" → "best-cut" in the wording.

### 4.5 Phase 4 plan diff (for orchestrator dispatch)

A1 micro-addition. The exact line ranges in `docs/plans/2026-04-22-phase4-plan.md` that need editing if this ADR is accepted (architect does not edit the plan; orchestrator should dispatch a separate edit task):

| Plan section | Lines | Edit |
|---|---:|---|
| §2.2 table header + rows 3–6 | 36–46 | Replace "Preuse-compact — threshold T1..T4" rows with "Preuse-substitute-compact — cut C1..C4" rows; update threshold column to "cumulative-input cut (tokens)" with values 10k / 50k / 100k / 150k (TBD-percentile if analyst data available). |
| §2.2 footnote line | 46 | Replace "Threshold selection (T1–T4) is gated on Q1" with "Cut grid (C1–C4) is gated on P4-pre-1 (substitute-compact summarizer spec) per ADR 2026-04-26-q1-prereq-redesign §3." |
| §3 sequencing block | 64–86 | Strike "Phase 4b can start in parallel with 4a only if Q7 (auto-compact disablement) confirms reproducibility for D/S/Pfresh/Pacc. Otherwise serial." (line 86); replace with "Phase 4b inherits the `-p` driver from Phase 3 per ADR 2026-04-26-q1-prereq-redesign §M1; reproducibility holds by construction." |
| §5 Q1 bullet | 104 | Replace entire bullet with: "**Q1 (Claude auto-compact exact threshold)** — SUPERSEDED by ADR 2026-04-26-q1-prereq-redesign. Phase 4c uses transcript-size cuts (Option A); no auto-compact threshold needed." |
| §5 Q7 bullet | 106 | Replace entire bullet with: "**Q7a (`-p` slice)** — resolved (V4 probe, ADR 2026-04-26-q1-prereq-redesign §M4). **Q7b (REPL slice)** — open, non-blocking for Phase 4 (trial harness is `-p`)." |
| §5 add new bullets | after 107 | Insert two bullets: "**P4-pre-1 (Substitute-compact summarizer spec)** — blocking for Phase 4c; owner: architect." and "**P4-pre-2 (Phase 3 transcript-size distribution pull)** — soft prereq for Phase 4c percentile-anchored cut grid; owner: analyst." |
| §8 R1 row | 143 | Replace "Q1 threshold measurement is noisy (e.g., depends on tool use count) — Measure across 3 representative workloads; publish range, not a point" with "Substitute-compact summarizer drift (deterministic across replications? cross-fixture stable?) — pin summarizer spec under Phase 4 pre-registration tag; verify byte-equality across two implementations before kickoff." |
| §6 F-Q1 bullet | 116 | Replace "F-Q1: threshold sensitivity — run Preuse-compact at threshold ± 20% to check decision stability" with "F-Q1: cut sensitivity — re-run Preuse-substitute-compact-C(best) at ±20% transcript-size cuts to check decision stability." |

These are mechanical edits — no judgment required beyond paste. Orchestrator may dispatch to `aigentry-orchestrator-coder` (or self-edit, since the plan lives in the orchestrator project).

---

### 4.6 `substitute-compact-v1` — normative spec (P4-pre-1)

Adopted **verbatim** from Codex review §4 ("Minimum-Viable Substitute-Compact Spec", `docs/adr/2026-04-26-q1-prereq-redesign-review-codex.md:35–55`). This section is a normative byte-level contract, not an example. It satisfies P4-pre-1 in §3 — the prereq is no longer a stub. Two independent implementations conforming to this spec MUST produce byte-equal output on the §4.6.10 regression manifest set.

Per dispatch (`shared/243593f5…`) lesson: Codex's spec is gold; do not redesign. The wording is preserved verbatim except for surface re-formatting (numbered subsections, code-block fencing) for readability. The decision content — function signature, manifest schema, ordering rule, normalization, preserved/banned fields, length caps, boundary semantics, output skeleton, regression gate — is byte-equal to Codex review §4.

#### 4.6.1 Name

`substitute-compact-v1`.

#### 4.6.2 Invocation

A pure function `build_substitute_compact_stdin(manifest) -> UTF-8 bytes`. **MUST NOT** call a model, **MUST NOT** shell out to a tokenizer, **MUST NOT** read files not named in the manifest.

#### 4.6.3 Manifest input

JSON with sorted keys in examples; implementations **MUST** read by key rather than object order. Required fields:

- `schema_version=1`
- `cut_id` (e.g., `C1`, `C2`, `C3`, `C4`)
- `cut_tokens` (integer; e.g., 10_000 for C1)
- `run_idx`
- `session_idx`
- `segment_start_position`
- `compact_before_position`
- `current_position`
- `current_fixture_id`
- `current_task_prompt_path`
- `setup_history_path`
- `prior_turns` — array; each item contains:
  - `position_in_chain`
  - `fixture_id`
  - `seed_idx`
  - `task_prompt_path`
  - `stage1_output_path`

#### 4.6.4 Ordering rule

Output MUST be:

1. Fixed header (the `SUBSTITUTE-COMPACT-V1` label and `METADATA` block).
2. Setup excerpt (`SETUP_HISTORY_EXCERPT`).
3. Prior turns sorted by **numeric `position_in_chain` ascending** (each turn block uses the labels in §4.6.8).
4. Current task (`CURRENT_TASK_PROMPT`).

Implementations **MUST NOT** enumerate directories. All paths come from the manifest.

#### 4.6.5 Normalization

- Read all text as **UTF-8 strict** (decoding errors are hard failures).
- Remove a UTF-8 BOM **only at file start**.
- Convert `CRLF` and bare `CR` to `LF`.
- Preserve all other bytes after decoding.
- Emit exactly `LF` line endings.
- The final output MUST end with one `LF`.

#### 4.6.6 Fields preserved in prompt

**Include**: `cut_id`, `cut_tokens`, `run_idx`, `session_idx`, `segment_start_position`, `compact_before_position`, `current_position`, prior `position_in_chain`, prior `fixture_id`, prior `seed_idx`.

**Exclude**: timestamps, absolute paths, session IDs, CLI versions, costs, cache tokens, host names, user names.

#### 4.6.7 Length caps (UTF-8 boundary-safe)

| Field | Cap (bytes) | Truncation rule |
|---|---:|---|
| Setup excerpt | 16,384 | First 16,384 bytes after normalization, truncated only at a valid UTF-8 boundary. |
| Each prior task prompt excerpt | 8,192 | First 8,192 bytes (UTF-8 boundary-safe). |
| Each prior assistant output excerpt | 8,192 | **Last** 8,192 bytes (UTF-8 boundary-safe). |
| Compact preamble (excluding current task) | 131,072 | If total exceeds 131,072 after assembly, drop **oldest prior-turn sections whole** until under cap. Never partially drop a turn block. |
| Current task prompt | uncapped by summarizer | Appended in full. |

#### 4.6.8 Output skeleton (fixed ASCII labels)

```
SUBSTITUTE-COMPACT-V1
METADATA
…
SETUP_HISTORY_EXCERPT
…
PRIOR_TURN position=<n> fixture=<id> seed=<n>
PRIOR_USER_PROMPT_EXCERPT
…
PRIOR_ASSISTANT_OUTPUT_EXCERPT
…
CURRENT_TASK_PROMPT
…
```

Labels are **ASCII** (no Unicode) and **case-sensitive**. Implementations **MUST** emit exactly these labels.

#### 4.6.9 Boundary semantics (binds §4.1 to this spec)

Before position `p>1`, compute:

```
segment_input_tokens = sum(metrics.cost.usage_buckets.input_tokens
                           for completed positions in
                           [segment_start_position, p-1])
```

If `segment_input_tokens >= cut_tokens`:

1. Build manifest with `current_position=p`, `compact_before_position=p`.
2. Invoke `build_substitute_compact_stdin(manifest)`.
3. Run **cold** `claude -p` (no `--resume`) with the result on stdin.
4. Extract new session_id from the resulting stage1 jsonl (existing helper: `execmode::harness_extract_session_id`, `bin/lib/exec-mode-lib.sh:246–262`).
5. **Overwrite** `chain_state.session_id` (existing helper: `execmode::chain_state_set_session_id`, `bin/lib/exec-mode-lib.sh:320–360`).
6. Set `segment_start_position=p` for later positions (new chain-state field — see §4.6.10 chain-state delta).

If not crossed: run existing Pacc `claude -p --resume <prior_sid>` unchanged.

**Chain-state delta**: `chain_state.json` schema (`bin/lib/exec-mode-lib.sh:226–237`) gains one new top-level integer field `segment_start_position` (default 1; updated on each substitute-compact firing). Existing `session_id` and `fixtures_completed` semantics are unchanged. This is an additive schema change — back-compat per §7.

#### 4.6.10 Byte-drift ban list (C5 — normative)

Implementations of `build_substitute_compact_stdin` **MUST NOT** use any of the following inside the summarizer (each is a documented byte-drift source in this harness surface; per Codex review §3 bullet 5):

1. **Tokenizer-based truncation** — caps are byte-counted, not token-counted.
2. **Wall-clock timestamps** — none in the prompt; metadata block carries position/cut identifiers only.
3. **Absolute paths** — manifest-relative or basename only.
4. **Session IDs** — explicit exclude in §4.6.6.
5. **CLI versions** — explicit exclude in §4.6.6.
6. **Filesystem enumeration order** — never `os.listdir` / `glob` / `readdir`. All paths come from manifest.
7. **Python hash/set iteration order** — never iterate `set` / `dict` (Python <3.7 insertion order) for prompt construction. Use sorted `list` keyed explicitly.
8. **Locale-sensitive sorting** — sort numeric (`position_in_chain` is integer), not lexicographic. Pin `LC_ALL=C` per existing harness (`bin/exec-mode-experiment.sh:45`).

**MUST NOT** is the gatekeeper for V3 byte equality. A regression-set digest mismatch traceable to any of these eight sources is a hard reject.

#### 4.6.11 Regression gate (V3 enforcement — see §9)

Create **10 manifests** covering:

1. LF-only line endings.
2. CRLF line endings.
3. Multi-byte Unicode in setup + prior assistant.
4. Empty assistant output for one prior turn.
5. Single-line over-cap text (forces UTF-8 boundary truncation).
6. Multiple prior turns (≥4).
7. No prior assistant file present (file missing — manifest declares it; behavior: emit empty `PRIOR_ASSISTANT_OUTPUT_EXCERPT` block).
8. C1 cut (10k) at smallest boundary.
9. C4 cut (150k) at largest boundary.
10. Segment reset after a previous compact (manifest with `segment_start_position > 1` and `compact_before_position > segment_start_position`).

Phase 4c **pre-registration tag** MUST store **expected SHA-256 digests** for all 10 outputs. **V3 passes only if both implementations match all 10 digests byte-for-byte.** No partial-credit path.

#### 4.6.12 Why "v1" (versioning policy)

Future revisions (e.g., changing length caps, adding fields, changing label set) MUST bump the version (`substitute-compact-v2`, …) and re-publish digests. The version is recorded in the manifest (`schema_version`) and in the output header (`SUBSTITUTE-COMPACT-V1` label). Reading `substitute-compact-v2` output with a v1 digest set is a hard error.

---

### 4.7 Layer placement and per-CLI adapter (G1 + G2)

Per Gemini review §4 + §5 condition 1 (`docs/adr/2026-04-26-q1-prereq-redesign-review-gemini.md:25–30`).

#### 4.7.1 Layer declaration

The abstract operation `preuse-substitute-compact` lives in **Layer 2** (cross-CLI portable, mediated by per-CLI adapter), not Layer 1.

Rationale: Rule 4-A's cross-everything mandate requires that any operation declared "available across CLIs" pass through an adapter that handles per-CLI invocation differences. While the *raw* `claude -p [--resume]` call is technically Layer 1 (Claude-internal), the *abstract concept* `preuse.compact(prompt, segment_state)` must live in Layer 2 to prevent Layer 1 assumption bleed into cross-CLI guidance (the failure mode Rule 4-A Step 5 names explicitly).

During Phase 4+5 (Narrow Lock per Rule 4-0): the adapter is a **Claude-only stub** — it accepts the abstract `preuse.compact(...)` call and routes to the Claude-specific cold `claude -p` invocation in §4.6.9. Codex / Gemini adapter implementations are **Phase 6+ work**, not blocking for Phase 4 kickoff.

#### 4.7.2 Per-CLI adapter responsibility

Adapter signature (informal): `cli_invoke(prompt: bytes, resume: Optional[str]) -> CliResult`.

| CLI | `-p` flag | `--resume` equiv | drop-resume primitive | summarizer parse | token-count base | adapter-translation rule |
|---|---|---|---|---|---|---|
| **Claude** | Yes (`--print`) | Yes (`--resume`) | Native | Yes | status line / `/btw` | `claude --print [--resume <id>]` (today's harness) |
| **Codex** | No (`exec` subcommand) | Yes (`resume` subcommand) | **Needs adapter** | Yes | `/status` / `effective_context_window` | `codex exec` for cold; `codex resume <id> exec` for resumed — subcommand routing required |
| **Gemini** | Yes (`--prompt`) | Yes (`--resume <tag>`) | Native (v0.39.1) | Yes | unknown | `gemini --prompt [--resume <tag>]` |

(Source for Codex / Gemini behavior: Gemini review §2 ¶1–2 + §3 portability table, `…review-gemini.md:10–11, 19–23`.)

The Layer 2 adapter abstracts these into a single `cli_invoke` call. Phase 4+5 only exercises the Claude row; Phase 6+ adds Codex + Gemini rows. The summarizer (§4.6) is **fully CLI-agnostic** — it produces UTF-8 bytes that all three CLIs parse equivalently as standard text/markdown payload.

#### 4.7.3 Phase 4+5 scope reaffirmation

Phase 4 + Phase 5 remain Claude-only per Rule 4-0 Narrow Lock (`docs/adr/2026-04-22-rule-4-mode-selection.md` §2.1, §5). No cross-CLI execution in Phase 4/5; the Layer 2 adapter is structurally present but only the Claude branch is exercised. This means G1 acceptance does not introduce Phase 4 work — it documents the abstraction so future Codex/Gemini extensions inherit the cleanly-bounded primitive.

---

## 5. Phase 3 re-analysis recommendation

**Verdict**: **Phase 3 analyst report does NOT require a corrigendum.**

**Justification**: M5 finding — analyst already recorded compact rate 0/399 (line 58) as a baseline-clean property, and the Pacc decay attribution (§6) does not cite auto-compact as a cause. The decay is attributed to structural Pacc behavior (cache-efficient `--resume` reading; per-position quality collapse from position 3 onward) and the apparent pos=10 rebound is decomposed as a fixture-mix artifact. None of these attributions depends on auto-compact firing or not firing.

**Recommended caveat note (NOT a corrigendum)**: when the next analyst report is produced (Phase 4b or later), include a one-paragraph footnote of the form:

> The "compact.detected=0/N" baseline check first reported in Phase 3 §4 is reinforced by the V4 probe (ADR 2026-04-26-q1-prereq-redesign §M4): under the `-p` trial driver, auto-compact does not fire at cumulative input ≥753k tokens — well beyond the Phase 3 spec context cap of 200k. The Phase 3 §6 Pacc decay attribution is therefore unaffected; Pacc decay is a structural mode property, not a transcript-management artifact.

Owner: next analyst session. Non-blocking.

---

## 6. Status

**Status: Proposed.** Orchestrator + user decide adoption.

### 6.1 Open-questions tracker patches (A2 micro-addition)

Exact prose updates for `docs/research/open-questions-tracker.md`. Architect does NOT edit the tracker directly; orchestrator should dispatch a separate edit task using the patches below.

#### Patch 6.1.A — Q1 supersede

Replace the **entire `## Q1 — Claude Code auto-compact exact threshold` section** (lines 11–19 of `docs/research/open-questions-tracker.md` as of commit `4d047fa`) with:

```
## Q1 — Claude Code auto-compact exact threshold (SUPERSEDED)

- **Topic**: cross-CLI, Preuse-compact selection (Rule 4-A Step 4).
- **Status**: superseded — 2026-04-26.
- **Source**: dustcraw report `~/projects/aigentry-orchestrator/docs/research/2026-04-21-cli-context-reset-compare.md` (commit `e633566`).
- **Why superseded**: V4 probe (`docs/research/2026-04-26-q1-claude-threshold-runs/raw/probe_V4_s42.{csv,log,jsonl}`) showed `claude -p --resume` does not trigger auto-compact at cumulative input ≥753,828 tokens. The Phase 4 trial driver is `-p` (verified at `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:229`); under that driver no auto-compact threshold exists to be measured.
- **Replacement prereq**: P4-pre-1 (Substitute-compact summarizer spec) and P4-pre-2 (Phase 3 transcript-size distribution pull) — see ADR `docs/adr/2026-04-26-q1-prereq-redesign.md` §3.
- **Phase 4c arm semantic**: see same ADR §4 (transcript-size cuts replace threshold anchors).
- **Re-open trigger**: if Phase 4 introduces an interactive REPL driver (e.g., `script(1)` PTY wrapper), re-instantiate Q1 scoped to the REPL slice.
```

#### Patch 6.1.B — Q7 split

Replace the **entire `## Q7 — Auto-compact disablement per CLI` section** (lines 72–80) with two new sections:

```
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
```

#### Patch 6.1.C — Change-log entry

Append to the `## Change log` section (after current line 95):

```
- **2026-04-26** — Q1 superseded; Q7 split into Q7a (RESOLVED, `-p` slice) and Q7b (OPEN, REPL slice). Driver: ADR `docs/adr/2026-04-26-q1-prereq-redesign.md`. Evidence: V4 probe artifacts in `docs/research/2026-04-26-q1-claude-threshold-runs/raw/`.
```

### 6.2 Acceptance gate

This ADR is two-way (Phase 4 plan changes are revisable before kickoff). Per architect AGENTS.md §7 and the ADR's tier (T2: ADR + ecosystem scope), reviewer requirements are:

- **Reviewer 1 (Codex)**: implementation-complexity + Pacc-mechanics second opinion on Option A vs B. Specifically: "Is the substitute-compact summarizer specifiable byte-equally across two implementations? If not, what's the minimum-viable spec?"
- **Reviewer 2 (Gemini)**: cross-CLI implications. Specifically: "Does Option A's `-p`+rebuild semantic transfer to Codex / Gemini if Phase 5+ widens scope, or does it pin Preuse-substitute-compact to Layer 1 (matching Q5)?"

Orchestrator dispatches reviewers; architect responds to ACCEPT-IF / REQUEST-REVISION via the standard review-loop (max 3 iterations).

User approval is the final gate after reviewer ACCEPT.

---

## 7. Backward compatibility analysis

### 7.1 Affected artifacts

| Artifact | Path | Change |
|---|---|---|
| Open-questions tracker — Q1 | `docs/research/open-questions-tracker.md:11–19` | Status: open → superseded; body rewritten per Patch 6.1.A. |
| Open-questions tracker — Q7 | `docs/research/open-questions-tracker.md:72–80` | Split into Q7a (resolved) + Q7b (open) per Patch 6.1.B. |
| Open-questions tracker — change log | `docs/research/open-questions-tracker.md:95` | Append entry per Patch 6.1.C. |
| Phase 4 plan — §2.2 | `docs/plans/2026-04-22-phase4-plan.md:36–46` | Threshold-anchored arms → cut-anchored arms. Trial count unchanged (500). |
| Phase 4 plan — §3 | same:64–86 | Q7 conditional struck; replace with `-p` driver inheritance. |
| Phase 4 plan — §5 | same:100–108 | Q1/Q7 bullets rewritten; P4-pre-1 / P4-pre-2 added. |
| Phase 4 plan — §6, §8 | same:116, 143 | F-Q1 + R1 wording revised. |
| Rule 4-A Step 4 (Rule body) | `docs/rules.md` — Rule 4-A Step 4 (corresponds to ADR `docs/adr/2026-04-22-rule-4-mode-selection.md` §2.2) | Operator-facing wording keeps "Preuse-compact"; trial-vocabulary footnote added. *Owner: architect at Phase 4d post-data adoption — NOT this ADR.* |

### 7.2 Consumer impact

- **Phase 4b runner** (1,300 trials of replication + 500 Preuse): unaffected. Preuse arm count stays 500; only the per-arm semantic and the runner's substitute-compact branch change. Existing Phase 3 modes (D/S/Pfresh/Pacc) replicate unchanged.
- **Phase 5 holdout** (300 trials): unaffected — uses "best-threshold" Preuse-compact selected from Phase 4c. Selection logic adapts trivially from "best threshold" to "best cut".
- **Rule 4-A operator guidance**: no immediate change. Operator still sees "Preuse-compact at task boundary" as guidance; the trial-vocabulary footnote is for trial-result interpretation.
- **Existing data** (Phase 3, V4 probe): unaffected — both are read-only inputs to this ADR.
- **Pre-registration tag** for Phase 4 (`exec-mode-v4-replication-preregistered-YYYYMMDD`, plan §4): not yet committed. The tag should be created *after* this ADR is Accepted and the Phase 4 plan is edited per §4.5; pre-registration captures the new arm semantic.

### 7.3 Migration path

Strictly additive vs replacement:

- **Replacement**: Q1 tracker entry, Q7 → Q7a + Q7b split, Phase 4 plan §2.2 / §3 / §5 / §6 / §8 wording.
- **Additive**: P4-pre-1 (substitute-compact summarizer spec — new architect deliverable), P4-pre-2 (analyst transcript-size distribution pull — new analyst deliverable), trial-vocabulary footnote in Rule 4-A.

No data migration required (no live data depends on Q1 being open). No pre-registration mid-flight.

### 7.4 Token-counting parity — uncontrolled variable across CLIs (G3)

Per Gemini review §5 condition 3 (`docs/adr/2026-04-26-q1-prereq-redesign-review-gemini.md:32`).

The `cut_tokens` values in §4.1 (10k / 50k / 100k / 150k) are measured via `metrics.cost.usage_buckets.input_tokens` from the **Claude** stage1 jsonl `result` records (existing harness path: `bin/exec-mode-experiment.sh:578–584`, schema `state/schema/metrics.v1.json:104–119`). This is well-defined and stable for Phase 4+5 (Claude-only Narrow Lock).

**However**: cross-CLI equivalence of `cut_tokens` is not yet established. Per Gemini review §2 ¶4 + §3 portability table:

- Claude reports tokens via status line / `/btw`.
- Codex reports via `/status` / `effective_context_window`.
- Gemini's token-counting primitive is currently unknown to the adapter (`docs/research/2026-04-21-cli-context-reset-compare.md` §7.3, §8.4).
- Even when the *number* aligns, the *base* may differ — cumulative full transcript vs user-only turns vs system-prompt-inclusive.

**Consequence**: a `cut_tokens=100_000` arm on Claude is **not** automatically equivalent to a `cut_tokens=100_000` arm on Codex or Gemini. Until tracker **Q4 (cross-CLI uniform token counter primitive)** is resolved, the same `cut_tokens` value means different things on different CLIs. This is flagged here as an **uncontrolled variable** for Phase 6+ cross-CLI extension.

**Phase 4+5 impact**: none — Claude-only by Rule 4-0 Narrow Lock.

**Phase 6+ blocker**: Q4 must be resolved before the Layer 2 adapter (§4.7) can apply identical cuts across CLIs, OR the adapter must publish a per-CLI cut conversion table (e.g., "Claude 100k ↔ Codex 87k ↔ Gemini 110k"), with empirical calibration at the time of cross-CLI extension.

This caveat does not change the Phase 4+5 plan; it documents the boundary where the Layer 2 abstraction in §4.7 actually starts costing more than it returns, so a future architect knows to bring Q4 forward before activating Codex/Gemini rows.

---

## 8. Constitution check

Per architect AGENTS.md §5.5, every ADR carries a §Constitution Check section. aigentry headquarters constitution `~/projects/aigentry/docs/CONSTITUTION.md`.

| # | Question | Verdict | One-sentence justification |
|---|---|:-:|---|
| 1 | Does this serve AI-gap closure? | PASS | Tightening the Phase 4 prereq prevents wasted trial budget on a fictitious threshold sweep, accelerating Rule 4-0 → Full Lock validation. |
| 2 | Whose role is this change? | PASS | Architect (this ADR — design + plan diff). Orchestrator (dispatch tracker + plan edits). Analyst (Phase 3 transcript-size pull, optional). All within published role boundaries. |
| 3 | Is the framework necessary? | PASS | No new framework introduced — reuses existing ADR mechanism, existing tracker format, and existing Phase 4 plan structure. |
| 4 | Cross-everything operability? | PASS-WITH-NOTE | Rule 4-0 Narrow Lock keeps Phase 3+4 Claude-only; this ADR does not widen scope. **Rev2 update**: Gemini reviewer (ACCEPT-IF) confirmed Option A is portable with adapter mediation — see §4.7 (Layer 2 placement, per-CLI adapter table) and §7.4 (token-counting parity uncontrolled variable, blocks Phase 6+ until Q4 resolves). The abstraction is documented now so Phase 6+ inherits a clean primitive. |
| 5 | Does this force "how" on users? | PASS | Operator-facing Rule 4-A vocabulary is preserved ("Preuse-compact"). Only the trial-harness primitive is renamed (substitute-compact), with a footnote — invisible to operators. |

Per Constitution §17 (independence): this ADR introduces no new external dependencies; the substitute-compact summarizer is harness-internal (architect deliverable), avoiding model calls or third-party libraries.

---

## 9. Verification plan

| ID | Metric | Measurement | Success threshold | When measured |
|---|---|---|---:|---|
| **V1** | Phase 4 plan edits applied per §4.5 diff | grep'able: §2.2 contains "Preuse-substitute-compact"; §5 has P4-pre-1 + P4-pre-2 bullets; §3 lacks "Q7 ... confirms reproducibility"; §6 lacks "threshold ± 20%". | All five grep checks pass. | Post-orchestrator-dispatch, before pre-registration tag. |
| **V2** | Tracker patches applied per §6.1 | `## Q1` body contains "SUPERSEDED"; `## Q7a` and `## Q7b` exist; change-log has 2026-04-26 entry. | All three checks pass. | Same as V1. |
| **V3** | Substitute-compact summarizer specifiable byte-equally | P4-pre-1 spec landed in §4.6 (`substitute-compact-v1`, Codex review §4 verbatim). Two independent implementations (e.g., builder + dustcraw) consume the **10 manifests in §4.6.11** (LF, CRLF, Unicode, empty assistant output, single-line over-cap, multi-prior-turn, missing-prior-assistant, C1 cut, C4 cut, post-compact segment-reset). Phase 4c **pre-registration tag** stores expected SHA-256 digests for all 10 outputs. **No partial-credit path**: V3 passes only if both implementations match all 10 SHA-256 digests byte-for-byte. Each MUST-NOT in the §4.6.10 ban list (tokenizer truncation, wall-clock, absolute paths, session IDs, CLI versions, fs enumeration order, hash/set order, locale-sort) is a documented byte-drift failure mode → mismatch traceable to any of these eight is a hard reject, not a "fix and re-run". | All 10 SHA-256 digests match between two implementations. | Phase 4c pre-kickoff (blocking). |
| **V4** | Cut grid set | 10k/50k/100k/150k (default) or percentile-anchored equivalents committed in Phase 4 plan + pre-registration tag. | Values present in plan §2.2 + tag commit. | Pre-registration commit. |
| **V5** | Q7a re-test on Claude CLI version bump | If `claude --version` differs from V4-probe-recorded version when Phase 4b kicks off, re-run a single V1 + V4 probe pair to confirm no compact at ≥cap | Cap reached without compact marker. | Phase 4b kickoff (only on version change). |
| **V6** | Phase 4c per-arm result legibility | Phase 4d analyst report contains a per-arm quality-vs-cumulative-input scatter, identifying best-cut by Phase 3 baseline-Pacc delta | Scatter present + best-cut argmax stated with CI. | Phase 4d. |

V1, V2 are blocking for pre-registration commit. V3 is blocking for Phase 4c kickoff. V4 is blocking for Phase 4c trial fire. V5 is conditional. V6 is the success criterion for Rule 4-0 → Full Lock promotion (alongside Phase 4 plan §7 untouched criteria).

---

## 10. Related

- **Predecessor ADR**: `docs/adr/2026-04-22-rule-4-mode-selection.md` (Rule 4-0 / Rule 4-A — Accepted, Narrow Lock).
- **Predecessor plan**: `docs/plans/2026-04-22-phase4-plan.md` (Phase 4 — Draft).
- **Tracker**: `docs/research/open-questions-tracker.md` (Q1, Q7 entries to be patched per §6.1).
- **V4 probe artifacts**: `docs/research/2026-04-26-q1-claude-threshold-runs/raw/{probe_V4_s42.csv, probe_V4_s42.log, run_V4-s42.jsonl}`.
- **Phase 3 analyst report**: `~/projects/aigentry-devkit/docs/reports/2026-04-21-exec-mode-analyst-phase3.md` (commit `472cc9f`).
- **Phase 3 runner**: `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh` + `~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh`.
- **Sub-spec gate**: `~/projects/aigentry-architect/docs/spec-q1-prereq-redesign-sub.md` (APPROVED via shared `1d43e69d…`).
- **Orchestrator dispatch**: shared `8eebafe7…` (initial), `1d43e69d…` (APPROVED + clarifications).

### Failed approaches (per §6 architect AGENTS.md)

- **2026-04-26 (this ADR's investigation)**: did not fail — but a near-miss: M5 hypothesis assumed analyst likely cited auto-compact as Pacc decay cause. Falsified on direct read (analyst was already noise-clean per line 58). Lesson: when a hypothesis says "the analyst probably did X wrong", read first before scoping a corrigendum. Adding to architect AGENTS.md §6 as `§6.4 — false-attribution-of-error pattern: never schedule a corrigendum review without first reading the source attribution; M5-H5 falsification cost ~5 min of investigation but would have cost ~30 min of unnecessary corrigendum drafting.`

- **2026-04-26 (rev1 → rev2 review-loop)**: rev1 §M3 trade-off matrix mis-rated Option B's implementation cost as "Low" without disambiguating "B reset-only" (≈60–90 LOC) from "B with shared substitute summarizer" (≈140–220 LOC). Codex review §2 ¶4 corrected: A's incremental cost over B-with-summarizer is only ≈30–50 LOC, not the meaningful gap implied by the table. Cost is therefore not a meaningful tiebreaker; the decisive factor is confound risk in B. Lesson: when listing "Implementation cost" trade-offs, decompose cost by which sub-features are shared between options. Adding to architect AGENTS.md §6 as `§6.5 — trade-off-matrix shared-cost decomposition: when an "alternative" reuses ≥30% of the recommended option's implementation, label its cost as "X (alone) / Y (with shared component)" to avoid misleading the cost column.`

---

## 11. Revision history

- **rev1 — 2026-04-26 (Proposed)**: initial ADR, sub-spec gate `1d43e69d…` APPROVED. Reviewer feedback (rev1 close):
  - Codex (`Q1-codex-reviewer`, `…review-codex.md`) — ACCEPT-IF, byte-equal feasibility conditional on landing a normative `substitute-compact-v1` spec; provided a complete spec in review §4 (180–260 LOC, conditional <1 week to two-implementation byte equality if spec adopted as-is).
  - Gemini (`…review-gemini.md`) — ACCEPT-IF, Layer 2 placement recommended, Codex command-translation requirement flagged, Gemini portability confirmed, token-counting parity uncontrolled until Q4 resolves.

- **rev2 — 2026-04-26 (Proposed; this revision)**: incorporated 8 reviewer changes per orchestrator dispatch `shared/243593f5…`:
  - **C1** (Codex) — replaced rev1 §4.1 "example summarizer" wording with §4.6 normative `substitute-compact-v1` spec, adopted verbatim from Codex review §4 (12 subsections: name, invocation, manifest, ordering, normalization, preserved/banned fields, length caps, output skeleton, boundary semantics, ban list, regression gate, versioning).
  - **C2** (Codex) — §4.1 boundary semantics: per-segment (since `segment_start_position`), not global cumulative input. New `chain_state.segment_start_position` field added (additive schema change; §4.6.9).
  - **C3** (Codex) — §4.1 operational semantic: cold `claude -p` (no `--resume`); extract new session_id; overwrite `chain_state.session_id`; advance `segment_start_position=p`. Existing `--resume` path unchanged on non-compact positions.
  - **C4** (Codex) — §9 V3 metric tightened: explicit reference to §4.6.11 ten-manifest set + SHA-256 digest gating in pre-registration tag; no partial-credit path; ban-list traceability is hard reject.
  - **C5** (Codex) — §4.6.10 normative ban list with eight MUST-NOT items (tokenizer truncation, wall-clock, absolute paths, session IDs, CLI versions, fs enumeration order, hash/set order, locale-sort). Each item carries a documented byte-drift rationale.
  - **G1** (Gemini) — §4.7 Layer placement: `preuse-substitute-compact` is Layer 2, mediated by per-CLI adapter; Phase 4+5 adapter is Claude-only stub; Codex/Gemini adapter rows are Phase 6+ work.
  - **G2** (Gemini) — §4.7.2 per-CLI adapter table: Claude `--print [--resume]`, Codex `exec` / `resume` subcommand routing, Gemini `--prompt [--resume]` (v0.39.1). Adapter signature `cli_invoke(prompt, resume=None) -> CliResult`.
  - **G3** (Gemini) — §7.4 token-counting parity: documented as uncontrolled variable across CLIs until tracker Q4 resolves; Phase 6+ blocker for cross-CLI cut equivalence; Phase 4+5 impact = none.
  - **B-cost footnote** (Codex §2 ¶4) — §M3 trade-off matrix Implementation cost column updated with footnote distinguishing B-reset-only (≈60–90 LOC) from B-with-summarizer (≈140–220 LOC); A's incremental cost over B-with-summarizer ≈30–50 LOC; cost is not a meaningful tiebreaker.

  All §1–§3, §5–§6, §10 wording from rev1 preserved unchanged. §M3 narrative wording preserved (only the trade-off table cost column gained a footnote). Sub-spec gate, dispatch authorization, and INVARIANTS posture unchanged.

  rev2 self-check (CLAUDE.md §6 7-item rubric): 7/7 PASS. INVARIANTS §5.1–§5.10 PASS (new §4.6 stays in markdown; spec is *executable contract* per Codex but not *executable code* per architect §5.1 — `pseudo` fence not needed because the spec is normative prose + JSON schema, not Python/Rust). All new claims cite either a reviewer file path:line or an existing repo path:line.

