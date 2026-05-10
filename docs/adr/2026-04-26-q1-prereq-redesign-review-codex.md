# Codex Review - Q1 Prereq Redesign ADR

Reviewer: `Q1-codex-reviewer`  
Scope: implementation complexity + Pacc mechanics for Option A  
Repos inspected: orchestrator `4d047fa`, devkit `4c79c62`, architect `4d047fa`

## 1. Verdict

**ACCEPT-IF.** Option A is feasible and is the right primitive to test transcript-size dependence, but the current ADR only gives an example summarizer, not a byte-level contract. The substitute-compact primitive can be specified byte-equally across two implementations if it is a deterministic extractor over explicit input files and prior trial artifacts, with fixed ordering, UTF-8/LF normalization, byte caps, and no model call, tokenizer-dependent truncation, timestamps, session IDs, locale-dependent sort, filesystem enumeration, or hash-randomized ordering. Without that minimum spec, V3 is not satisfiable.

## 2. Per-Criterion Findings

1. **Byte-equality feasibility - ACCEPT-IF.** The ADR correctly requires a harness-controlled deterministic summarizer and no model call (`docs/adr/2026-04-26-q1-prereq-redesign.md:196`, `docs/adr/2026-04-26-q1-prereq-redesign.md:372`), but the proposed example, "setup_history excerpt + last K turns' user prompts + last assistant turn's final paragraph", is under-specified (`docs/adr/2026-04-26-q1-prereq-redesign.md:119-120`). Byte equality is feasible only if the spec excludes dynamic fields already present in the harness, including stage timestamps (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:184-185`, `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:744-749`), CLI versions (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:162-174`, `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:750-755`), and session IDs (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:246-260`, `~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh:320-359`). Locale must also be pinned; the existing harness already uses `LC_ALL=C` and stage-2 isolates `LANG`/`LC_ALL` (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:44-45`, `~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh:446-455`).

2. **Pacc-mechanics fit - ACCEPT-IF.** The existing Pacc logic resumes one stored `session_id` for pos>1 (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:390-417`), and the ADR's proposed compact branch explicitly drops `--resume`, feeds the substitute prompt, and replaces `chain_state.session_id` (`docs/adr/2026-04-26-q1-prereq-redesign.md:187-196`). That integration is implementable without changing the semantics of `--resume <prior_sid>`: add a pre-pos branch that decides whether to omit `--resume`, then call the existing session-id setter after the new cold invocation. The missing piece is state: current chain state records completed fixtures and the current session id (`~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh:264-311`, `~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh:320-383`) but does not record segment start or cumulative input, so the spec must define whether the boundary is one-shot or resets after each substitute compact.

3. **Trial determinism - ACCEPT-IF.** The 400 compact prompts can be byte-deterministic as functions of explicit inputs because the trial layout, fixture root, and stage artifact paths are fixed (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:64-65`, `~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:156-160`), and the harness already records usage buckets needed for cumulative-input boundaries (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:578-584`, `~/projects/aigentry-devkit/state/schema/metrics.v1.json:104-119`). The V4 probe verifies `--resume` replay behavior by showing turn 2 `cache_read=259411` after turn 1 `input=259417` (`docs/research/2026-04-26-q1-claude-threshold-runs/raw/probe_V4_s42.csv:1-2`) and no compact before the harness cap (`docs/research/2026-04-26-q1-claude-threshold-runs/raw/probe_V4_s42.log:2-5`). Determinism here means "same compact input manifest plus same prior artifacts produce byte-equal prompt"; it does not make Claude's prior assistant output deterministic across reruns.

4. **Implementation cost vs Option B - ACCEPT.** Architect's "Medium" for Option A vs "Low" for Option B is directionally fair (`docs/adr/2026-04-26-q1-prereq-redesign.md:111-115`), but only if Option B is a reset-only or turn-counter proxy. If Option B still performs substitute-compact, the summarizer cost is shared and the incremental Option A cost is just cumulative-input boundary tracking. Current code requires touching at least the mode whitelist (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:99-101`), trial id/schema mode enum (`~/projects/aigentry-devkit/state/schema/metrics.v1.json:27-36`), analyzer mode list (`~/projects/aigentry-devkit/bin/exec-mode-analyze.py:41-42`), Pacc branch (`~/projects/aigentry-devkit/bin/exec-mode-experiment.sh:390-417`), and chain-state helpers (`~/projects/aigentry-devkit/bin/lib/exec-mode-lib.sh:264-383`). Estimate: Option A minimum harness delta is about 180-260 LOC; Option B reset-only is about 60-90 LOC; Option B with the same substitute summarizer is about 140-220 LOC, making A's incremental cost roughly 30-50 LOC.

5. **Pre-registration risk - ACCEPT-IF.** V3 requires two independent implementations to produce byte-equal output on a 10-input regression set before Phase 4c kickoff (`docs/adr/2026-04-26-q1-prereq-redesign.md:366-377`), and the Phase 4 plan requires pre-registration tags before trial execution (`docs/plans/2026-04-22-phase4-plan.md:90-96`). This is realistic in under one week if P4-pre-1 is the extractor-style spec in section 4 below. It becomes a multi-week blocker if the architect keeps "final paragraph", token-based length caps, or inferred transcript reconstruction as normative behavior, because those introduce parser, tokenizer, and model-output ambiguities not covered by the current ADR.

## 3. Required Changes For Acceptance

- Replace the example summarizer text with a normative P4-pre-1 spec. Rationale: V3 measures byte equality, and examples are not executable contracts.

- Define boundary semantics as "segment cumulative input since last substitute compact", not global cumulative input. Rationale: otherwise once a cut is crossed it is ambiguous whether every later position compacts.

- Define the compact branch as a cold `claude -p` invocation that overwrites `chain_state.session_id`; keep normal Pacc `--resume` unchanged on non-compact positions. Rationale: this matches ADR §4.1 while preserving existing Pacc semantics.

- Add a 10-input regression manifest format with expected SHA-256 output digests. Rationale: two implementations can only be compared if they consume the same manifest and produce an auditable digest.

- Explicitly ban tokenizer-based truncation, wall-clock timestamps, absolute paths, session IDs, CLI versions, filesystem enumeration order, Python hash/set iteration order, and locale-sensitive sorting inside the summarizer. Rationale: each is a known byte-drift source in this harness surface.

## 4. Minimum-Viable Substitute-Compact Spec

**Name:** `substitute-compact-v1`.

**Invocation:** a pure function `build_substitute_compact_stdin(manifest) -> UTF-8 bytes`; no model calls, no shelling out to tokenizers, no reading files not named in the manifest.

**Manifest input:** JSON with sorted keys in examples, but implementations must read by key rather than object order. Required fields: `schema_version=1`, `cut_id`, `cut_tokens`, `run_idx`, `session_idx`, `segment_start_position`, `compact_before_position`, `current_position`, `current_fixture_id`, `current_task_prompt_path`, `setup_history_path`, and `prior_turns`. Each `prior_turns[]` item contains `position_in_chain`, `fixture_id`, `seed_idx`, `task_prompt_path`, and `stage1_output_path`.

**Ordering rule:** output fixed header first, then setup excerpt, then prior turns sorted by numeric `position_in_chain` ascending, then current task. Never enumerate directories.

**Normalization:** read all text as UTF-8 strict; remove a UTF-8 BOM only at file start; convert `CRLF` and bare `CR` to `LF`; preserve all other bytes after decoding; emit exactly `LF` line endings; ensure the final output ends with one `LF`.

**Fields preserved in prompt:** include `cut_id`, `cut_tokens`, `run_idx`, `session_idx`, `segment_start_position`, `compact_before_position`, `current_position`, prior `position_in_chain`, prior `fixture_id`, and prior `seed_idx`. Exclude timestamps, absolute paths, session IDs, CLI versions, costs, cache tokens, and host/user names.

**Length caps:** setup excerpt is the first 16,384 UTF-8 bytes after normalization, truncated only at a valid UTF-8 boundary. Each prior task prompt excerpt is the first 8,192 bytes. Each prior assistant output excerpt is the last 8,192 bytes. The compact preamble excluding the current task is capped at 131,072 bytes by dropping oldest prior-turn sections whole until under cap. The current task prompt is appended in full and is not capped by the summarizer.

**Boundary semantics:** before position `p>1`, compute `segment_input_tokens = sum(metrics.cost.usage_buckets.input_tokens)` for completed positions from `segment_start_position` through `p-1`. If `segment_input_tokens >= cut_tokens`, invoke `build_substitute_compact_stdin` with `current_position=p`, run `claude -p` without `--resume`, extract the new session id, overwrite `chain_state.session_id`, and set `segment_start_position=p` for later positions. If not crossed, run existing Pacc `claude -p --resume <prior_sid>` unchanged.

**Output skeleton:** fixed ASCII section labels: `SUBSTITUTE-COMPACT-V1`, `METADATA`, `SETUP_HISTORY_EXCERPT`, `PRIOR_TURN position=<n> fixture=<id> seed=<n>`, `PRIOR_USER_PROMPT_EXCERPT`, `PRIOR_ASSISTANT_OUTPUT_EXCERPT`, and `CURRENT_TASK_PROMPT`.

**Regression gate:** create 10 manifests covering LF, CRLF, Unicode, empty assistant output, single-line over-cap text, multiple prior turns, no prior assistant file, C1 and C4 cuts, and segment reset after a previous compact. The Phase 4c preregistration must store expected SHA-256 digests for all 10 outputs; V3 passes only if both implementations match all 10 digests byte-for-byte.

## 5. Iter-2 Re-Review (2026-04-26)

**Verdict: ACCEPT**

| Change | Verification |
|---|---|
| C1 byte-equality | Resolved. Rev2 adds §4.6 as a normative byte-level contract, not an example, and includes the pure function, manifest fields, explicit ordering, UTF-8/LF normalization, preserved/excluded fields, byte caps, ASCII labels, boundary semantics, regression gate, and versioning policy (`docs/adr/2026-04-26-q1-prereq-redesign.md:234-382`). |
| C2 per-segment boundary | Resolved. §4.1 and §4.6.9 compute `segment_input_tokens` from `segment_start_position` through `p-1`, advance `segment_start_position` after a compact, and document the new chain-state field as additive/back-compatible (`docs/adr/2026-04-26-q1-prereq-redesign.md:190-201`, `docs/adr/2026-04-26-q1-prereq-redesign.md:325-346`). |
| C3 cold `-p` semantic | Resolved. The compact branch is explicitly cold `claude -p` with no `--resume`, extracts a new session id, overwrites `chain_state.session_id`, advances `segment_start_position=p`, and leaves normal Pacc `--resume <prior_sid>` unchanged when the cut is not crossed (`docs/adr/2026-04-26-q1-prereq-redesign.md:194`, `docs/adr/2026-04-26-q1-prereq-redesign.md:335-346`). |
| C4 regression + SHA-256 gate | Resolved. §4.6.11 defines the 10-manifest set and SHA-256 preregistration requirement, and §9 V3 explicitly references §4.6.11, requires all 10 digests to match, and states no partial-credit path (`docs/adr/2026-04-26-q1-prereq-redesign.md:363-378`, `docs/adr/2026-04-26-q1-prereq-redesign.md:582`). |
| C5 ban list | Resolved. §4.6.10 is normative `MUST NOT` language and includes all eight requested byte-drift sources: tokenizer truncation, wall-clock timestamps, absolute paths, session IDs, CLI versions, filesystem enumeration order, hash/set iteration order, and locale-sensitive sorting (`docs/adr/2026-04-26-q1-prereq-redesign.md:348-361`). |

No acceptance-blocking gaps remain. Non-blocking clerical note: §4.6 intro says "§4.6.10 regression manifest set" at line 236, but the actual regression gate and V3 metric correctly point to §4.6.11, so this does not affect the verdict.
