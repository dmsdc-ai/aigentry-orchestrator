---
status: draft
date: 2026-04-26
topic: phase4c-v3-implementation-work-spec
track: "#329 E27 Phase 4c"
phase: 1 (spec only — implementation pending orchestrator approval)
related:
  - ADR: docs/adr/2026-04-26-q1-prereq-redesign.md §4.6 substitute-compact-v1 normative spec
  - Phase 4 plan: docs/plans/2026-04-22-phase4-plan.md §2.2 Preuse-substitute-compact arms
  - Tracker: docs/research/open-questions-tracker.md (P4-pre-1 + V3 metric gate)
constitution_rules: [Rule 1 경량, Rule 9 독립, Rule 17 무의존, Rule 26 cross-OS]
---

# Phase 4c V3 Implementation Work-Spec — `substitute-compact-v1` byte-equality

## §1 Goal

This work-spec **operationalizes** ADR `docs/adr/2026-04-26-q1-prereq-redesign.md` §4.6
(`substitute-compact-v1`) into a deliverable that produces V3 PASS — the gate for
Phase 4c kickoff.

**This spec governs:**
- Where the two `build_substitute_compact_stdin(manifest)` implementations live in
  the repo tree (§3).
- How impls A and B are isolated to make their independence auditable (§4).
- Who freezes the 10-manifest reference set, when, and how (§5).
- How byte-equality is verified and what PASS / FAIL means (§6).
- Which pre-registration artifact is produced and what it gates (§7).
- The diagnostic + remediation flow when A and B disagree (§8).

**This spec does NOT:**
- Redefine `substitute-compact-v1`. ADR §4.6.1–§4.6.12 is the byte-level contract
  and is binding verbatim. Where this spec touches the contract, it cites and
  defers; it does not restate.
- Implement either impl A or impl B. Implementation is Phase 2 work, dispatched
  by orchestrator after this spec is approved.
- Build the Layer 2 cross-CLI adapter. Per ADR §4.7.1, the Phase 4+5 adapter is
  a Claude-only stub; Codex / Gemini adapter rows are Phase 6+ work.
- Modify the trial harness arm wiring. Plan-§4.5 mechanical edits to
  `bin/exec-mode-experiment.sh` are dispatched separately by orchestrator
  (ADR §4.5 lines 218–229 of the ADR).

## §2 Inputs (must read before implementation dispatch)

| Source | Path | What it provides |
|---|---|---|
| ADR §4.6 (normative) | `docs/adr/2026-04-26-q1-prereq-redesign.md:235–383` | Function signature (§4.6.2), manifest schema (§4.6.3), ordering rule (§4.6.4), normalization (§4.6.5), preserved/excluded fields (§4.6.6), length caps (§4.6.7), ASCII output skeleton (§4.6.8), boundary semantics + chain-state delta (§4.6.9), eight-item ban list (§4.6.10), 10-manifest regression gate (§4.6.11), versioning (§4.6.12). |
| ADR §9 V3 row | `docs/adr/2026-04-26-q1-prereq-redesign.md:583` | V3 success threshold = "all 10 SHA-256 digests match between two implementations"; ban-list traceable failure = hard reject (no fix-and-rerun). |
| ADR §4.7 Layer placement | `docs/adr/2026-04-26-q1-prereq-redesign.md:387–397+` | `preuse-substitute-compact` is Layer 2; Phase 4+5 adapter is Claude-only stub. Reuse target for Phase 6+. |
| Phase 4 plan §2.2 | `docs/plans/2026-04-22-phase4-plan.md:36–46` | Cut grid C1–C4 = 10k / 50k / 100k / 150k cumulative-input tokens (default; analyst percentile-anchored values may supersede pre-tag). |
| Phase 4 plan §4 | `docs/plans/2026-04-22-phase4-plan.md:90–96` | Pre-registration tag `exec-mode-v4-replication-preregistered-YYYYMMDD` — required before any Phase 4 trial fires; registration authority = orchestrator + user. |
| Phase 4 plan §5 | `docs/plans/2026-04-22-phase4-plan.md:107–108` | P4-pre-1 = blocking for Phase 4c (architect, satisfied by ADR §4.6); P4-pre-2 = soft prereq (analyst, transcript-size distribution pull). |
| Tracker | `docs/research/open-questions-tracker.md:11–19` | Q1 SUPERSEDED status; replacement prereq = P4-pre-1 + P4-pre-2. |
| SAWP role table | `docs/sawp.md:18–28` | Role separation enforced for §6 harness role choice — verifier MUST NOT be impl A or impl B. |

P4-pre-2 status: **soft prereq, not blocking.** If unresolved at Phase 4c kickoff,
default cut grid 10k / 50k / 100k / 150k stands (Phase 4 plan §2.2 footnote at
line 46 already permits this).

## §3 Code Location Decision

### §3.1 Decision matrix (3 candidate locations)

| Criterion (weight) | A: `aigentry-devkit/bin/lib/preuse_substitute_compact/` | B: `aigentry-builder/.../substitute_compact/` | C: dedicated repo `aigentry-substitute-compact/` |
|---|---|---|---|
| (a) Rule 9 독립 — component standalone? | ✓ Pure-function module, no runtime dep on rest of devkit. | ✓ Standalone. | ✓ Maximum independence. |
| (b) Phase 6+ Layer 2 adapter reuse (ADR §4.7.1) | ✓ Stable import path; orchestrator can import from devkit/bin/lib or extract later. | △ Builder layer is for build/run, not runtime libs (SAWP role table, `docs/sawp.md:23`). Wrong layer. | ✓ Cleanest reuse boundary. |
| (c) Phase 4c trial driver coupling (`bin/exec-mode-experiment.sh`) | ✓ Driver already lives in `bin/`; co-located lib import is one-line (analogous to existing `bin/lib/exec-mode-lib.sh:226–237` referenced in ADR §4.6.9). | △ Driver would need cross-repo path indirection. | ✗ Cross-repo dependency adds friction every trial run. |
| (d) Test infrastructure proximity | ✓ Existing test harness lives under `aigentry-devkit/`; tests can sit beside the module. | △ Builder repo's test surface is build-system tests, not runtime-correctness tests. | △ New test infra to bootstrap. |
| Constitution Rule 1 경량 (no over-engineering) | ✓ One subdirectory, no new repo. | ✗ Wrong-layer placement = future refactor cost. | ✗ New repo = bootstrapping cost (CI, README, version bump cadence) for a single pure function. |

Option B is rejected on (b) + Constitution Rule 1: builder is not the right SAWP
role to host runtime library code (`docs/sawp.md:23` — builder = build + app run only).
Option C is rejected on Rule 1 경량: a single pure function does not justify a new
repo; if Phase 6+ Layer 2 adapter later requires extraction, that extraction is
itself a tractable refactor.

### §3.2 Recommendation

**Adopt Option A.**

Exact path: `~/projects/aigentry-devkit/bin/lib/preuse_substitute_compact/`

Required subtree (created by impl A and impl B; not by this spec):

```
aigentry-devkit/bin/lib/preuse_substitute_compact/
├── impl_a/                           # impl A (claude) — see §4
│   └── build_substitute_compact_stdin.py
├── impl_b/                           # impl B (codex) — see §4
│   └── build_substitute_compact_stdin.py
├── manifests/                        # 10 frozen manifests — see §5
│   ├── 01-lf-only.json
│   ├── 02-crlf.json
│   ├── 03-multibyte-unicode.json
│   ├── 04-empty-assistant.json
│   ├── 05-overcap-single-line.json
│   ├── 06-multi-prior-turns.json
│   ├── 07-missing-prior-assistant.json
│   ├── 08-c1-cut-smallest.json
│   ├── 09-c4-cut-largest.json
│   └── 10-segment-reset.json
└── digests/
    └── expected.sha256               # populated by V3 PASS — see §6
```

Each manifest filename is numbered to match ADR §4.6.11 enumeration order
(line 366–377). Manifest ordering is part of the freeze (§5.3).

The harness driver (§6) lives at `~/projects/aigentry-devkit/bin/v3-byte-equal-verify.py`,
peer to the existing `bin/exec-mode-experiment.sh` and `bin/exec-mode-analyze.py`
referenced in ADR §4.5.

## §4 Impl A vs Impl B Isolation Protocol

### §4.1 LLM independence

| Slot | LLM / CLI | Session ID | Spawned via |
|---|---|---|---|
| Impl A | claude (Opus 4.7) — fresh session | `aigentry-devkit-impl-a-claude` | `open-session.sh` (β-fixed, commit `7d874d6`) |
| Impl B | codex CLI — fresh session | `aigentry-devkit-impl-b-codex` | `open-session.sh` (β-fixed, commit `7d874d6`) |

Rationale: ADR §4.6 was authored verbatim by Codex (per ADR `docs/adr/2026-04-26-q1-prereq-redesign.md:237–239`).
Using one claude + one codex implementer is **not a conflict** — both are
implementing against a frozen normative spec, and convergence is the desired
outcome of V3. Cross-LLM independence reduces same-LLM convergence-via-shared-bias
(memory `feedback_dustcraw_evidence_required.md`: same LLM tends to converge on
the same hypothesis space; different LLMs surface different blind spots). The
contract is byte-level, so the only acceptable evidence of correctness is digest
equality, not implementation similarity.

### §4.2 File-tree layout

Strict directory boundary at `impl_a/` ↔ `impl_b/` (§3.2). Each impl session is
permitted to write **only** under its own subdirectory. Cross-write is a
discipline failure that invalidates V3 (see §4.4 audit).

### §4.3 No-cross-talk protocol

Each impl session receives, as its sole input bundle:

1. ADR §4.6 in full (`docs/adr/2026-04-26-q1-prereq-redesign.md:235–383`).
2. The 10 frozen manifests under `manifests/` (read-only after §5 freeze).
3. This work-spec (§3.2 path constraint, §4.2 directory boundary, §10 invariants).

Each impl session **MUST NOT** receive:
- The other impl's source code (in-progress or complete).
- The other impl's intermediate output, working notes, or debug logs.
- Reviewer notes that pertain to the other impl.
- The harness's PASS/FAIL output before its own implementation is complete.

Orchestrator brokers all artifacts. Sessions do not inject each other (per
`AGENTS.md:75` — session-to-session direct inject is forbidden outside
deliberation envelope, and deliberation is **not** invoked here because V3
requires independence, not consensus).

### §4.4 Auditability

A third-party verifier confirms independence by reading these artifacts:

1. **Open-session timestamps** — `~/.telepty/sessions/aigentry-devkit-impl-a-claude.json` and
   `…impl-b-codex.json` show fresh-session start times. Independent timestamps
   prove no continuation from a shared parent context.
2. **No shared cache** — both sessions launched with `--cwd=~/projects/aigentry-devkit`
   but each in a distinct telepty session ID; CLI process tree shows no shared
   parent PID after `open-session.sh`. (β-fix at commit `7d874d6` is what makes
   this auditable; pre-fix, session spawning leaked parent context.)
3. **Source-tree write log** — `git log --diff-filter=A` after V3 PASS shows
   `impl_a/build_substitute_compact_stdin.py` authored by one session ID
   (recorded in commit message footer per Rule 16) and `impl_b/...` by the other.
   Cross-authorship is a fail.
4. **Manifest read-only** — `manifests/` directory committed and frozen (§5.3
   commit hash) before either impl session starts. Both impls read identical
   bytes by construction.
5. **No deliberation envelope used** — orchestrator's deliberation MCP server
   transcript shows zero `deliberation_start` invocations naming impl A or impl
   B as participants between dispatch and V3 verification.

Any single audit signal failing = V3 invalidated; restart from freeze.

## §5 Reference 10-Manifest Set

### §5.1 Source

Manifests are **synthetic** — constructed to exercise the §4.6.5 normalization
rules, §4.6.7 length caps, §4.6.9 boundary semantics, and §4.6.10 ban list.
Phase 3 trial outputs are NOT used as raw manifests because (a) Phase 3 ran the
existing Pacc summarizer, not `substitute-compact-v1`, and (b) using Phase 3
trial artifacts would smuggle in unstable bytes (timestamps, session IDs,
cumulative input from real runs) that ADR §4.6.6 explicitly excludes.

Synthetic manifests reference **synthetic fixtures** placed in
`aigentry-devkit/bin/lib/preuse_substitute_compact/manifests/_fixtures/`
(setup_history.md, task_prompt.md, stage1_output.txt — one set per manifest).
Fixture content is hand-authored to hit each §4.6.11 coverage criterion.

### §5.2 Coverage criteria

The 10 manifests MUST cover the criteria enumerated in ADR §4.6.11 lines 366–377
(restated here only as the freeze checklist; the contract is the ADR):

1. LF-only line endings (baseline normalization no-op).
2. CRLF line endings (forces §4.6.5 CRLF→LF conversion).
3. Multi-byte Unicode in setup + prior assistant (UTF-8 strict path).
4. Empty assistant output for one prior turn (§4.6.7 row 3 edge: cap on empty).
5. Single-line over-cap text (forces §4.6.7 UTF-8 boundary truncation).
6. Multiple prior turns (≥4) sorted by `position_in_chain` ascending (§4.6.4).
7. No prior assistant file present — manifest declares the path; behavior:
   emit empty `PRIOR_ASSISTANT_OUTPUT_EXCERPT` block (ADR §4.6.11 row 7).
8. C1 cut (10k) at smallest boundary.
9. C4 cut (150k) at largest boundary.
10. Segment reset after a previous compact: `segment_start_position > 1` and
    `compact_before_position > segment_start_position` (§4.6.9 advance rule).

### §5.3 Authority and freeze

| Step | Owner | Action | Recorded as |
|---|---|---|---|
| 1. Author 10 manifests + fixtures | Orchestrator dispatches a **manifest-author** session (claude, role: aigentry-devkit-manifest-author-claude, fresh, NOT impl A or impl B). | Hand-author manifests + fixtures to satisfy §5.2 coverage. | Subdirectory `manifests/` and `manifests/_fixtures/` populated. |
| 2. Spec-conformance review | Orchestrator dispatches one reviewer (codex or gemini, NOT impl A) | Verify each manifest hits exactly its declared §5.2 criterion; flag duplicates or gaps. | Review markdown at `docs/reviews/manifest-set-review-{cli}.md`. |
| 3. **Freeze** | Orchestrator (after review ACCEPT) | `git add manifests/ manifests/_fixtures/`; `git commit -m "freeze: phase4c v3 manifest set"`. | **Commit hash** recorded in this work-spec §5.4 + linked from the pre-registration tag (§7). |
| 4. Distribution to impls | Orchestrator | Inject impl A and impl B with the **commit hash** of the freeze. Each impl session checks out that hash before reading manifests. | Inject log retained per Rule 11 (English) + Rule 16 (footer). |

### §5.4 Fail-closed property

Any change to `manifests/` or `manifests/_fixtures/` after the §5.3 step 3
freeze commit **invalidates the pre-registration tag**. Restart sequence:
re-author or re-edit (step 1) → re-review (step 2) → new freeze commit (step 3,
new hash) → impls re-run V3 against new hash → new pre-reg tag.

This is the same fail-closed discipline that ADR §9 V3 row imposes on the
implementations themselves.

Freeze commit hash: **`892c1a38e6b14dd33697ef0f10135c85097a3398`** (aigentry-devkit, 2026-04-26 by orchestrator after codex reviewer ACCEPT).

## §6 Byte-Equal Verification Harness

### §6.1 Runner role + cwd

| Property | Value |
|---|---|
| Session role | aigentry-tester-* (per SAWP `docs/sawp.md:24` — "테스트 실행, TC 작성/관리, 회귀 테스트") |
| Recommended session ID | `aigentry-devkit-v3-tester-claude` (any CLI; tester role is LLM-agnostic) |
| `--cwd` | `~/projects/aigentry-devkit/` |
| Permitted reads | `bin/lib/preuse_substitute_compact/impl_a/`, `…/impl_b/`, `…/manifests/`, `…/manifests/_fixtures/` |
| Permitted writes | `bin/lib/preuse_substitute_compact/digests/expected.sha256` (only on PASS), `docs/reports/2026-04-26-phase4c-v3-verification.md` |

The harness MUST be a separate session from impl A and impl B (Rule 9 독립
+ §4.4 audit signal 5: zero shared context). Co-locating harness in either impl
session compromises the "two implementations" basis of V3.

### §6.2 Invocation

```
cd ~/projects/aigentry-devkit
python3 bin/v3-byte-equal-verify.py \
  --impl-a bin/lib/preuse_substitute_compact/impl_a/build_substitute_compact_stdin.py \
  --impl-b bin/lib/preuse_substitute_compact/impl_b/build_substitute_compact_stdin.py \
  --manifests bin/lib/preuse_substitute_compact/manifests/ \
  --output bin/lib/preuse_substitute_compact/digests/expected.sha256
```

Environment: `LC_ALL=C` (matches existing harness `bin/exec-mode-experiment.sh:45`
per ADR §4.6.10 ban-list item 8). Locale leakage is itself a §4.6.10 violation.

### §6.3 Output format

Per-manifest line (10 lines), then aggregate:

```
01-lf-only:                    A=<sha256> B=<sha256> match=PASS
02-crlf:                       A=<sha256> B=<sha256> match=PASS
…
10-segment-reset:              A=<sha256> B=<sha256> match=FAIL
---
aggregate: 9/10 PASS, 1/10 FAIL
V3 verdict: FAIL (no partial credit per ADR §9)
```

On aggregate PASS (10/10), harness writes `digests/expected.sha256` (one digest
per line, manifest filename + space + sha256 hex). This file is the artifact
that the pre-registration tag references (§7).

### §6.4 V3 PASS / FAIL criterion

| Outcome | Definition (ADR §9 row V3) | Action |
|---|---|---|
| **PASS** | 10/10 manifests show byte-equal SHA-256 between impl A and impl B. | Harness writes `digests/expected.sha256`; orchestrator proceeds to §7 pre-reg tag. |
| **FAIL** | Any manifest entry shows mismatched SHA-256, OR aggregate < 10/10. | **No partial credit.** Diagnostic flow §8. |

### §6.5 On FAIL — which side rebuilds?

Neither side automatically "wins." The harness emits a divergence report
(`docs/reports/2026-04-26-phase4c-v3-verification.md`) listing:

1. Per-failed manifest: byte offset of first divergence (binary diff of impl A
   vs impl B output bytes).
2. Surrounding context: the §4.6.8 label section the divergence occurs in
   (e.g., `SETUP_HISTORY_EXCERPT`, `PRIOR_TURN position=…`).
3. Ban-list classification (§4.6.10): does the divergence trace to one of the
   eight `MUST NOT` items?
   - **YES** (any of items 1–8 in §4.6.10) → **hard reject** per ADR §9 V3 row;
     the violating impl is restarted from scratch in a fresh session (the
     non-violating impl is preserved as a calibration anchor).
   - **NO** → ADR §4.6 may be ambiguous on the divergence point; escalate to
     architect (§8.2).

Both sides rebuild only if both violate the ban list (rare).

## §7 Phase 4c Gating

### §7.1 Hard gate

V3 PASS (§6.4) is **blocking** for the pre-registration tag commit. This
restates ADR §9 V3 row's "blocking for Phase 4c kickoff" — the tag is the
artifact that records V3 has passed.

### §7.2 Tag format

`exec-mode-v4-replication-preregistered-YYYYMMDD` (per Phase 4 plan §4 line 92).

The tag MUST embed the §6.3 `digests/expected.sha256` content in its tag
message (annotated tag, not lightweight). This makes V3 PASS auditable post-hoc
without re-running the harness.

Tag commit also includes:
- Reference to §5.3 manifest freeze commit hash.
- Cut grid values (per Phase 4 plan §2.2 — default 10k/50k/100k/150k OR
  P4-pre-2 percentile-anchored if analyst delivered in time).
- Fixture set, seed list, mode set, grader harness version (Phase 4 plan §4
  scope clause, lines 93).

### §7.3 Soft gate

P4-pre-2 (analyst transcript-size distribution pull) is **soft**, not blocking
(Phase 4 plan §2.2 footnote line 46 + §5 line 108 + tracker `docs/research/open-questions-tracker.md:17`).
If unresolved at tag commit time, default cut grid 10k/50k/100k/150k stands and
the tag is committed unmodified.

If P4-pre-2 lands BEFORE tag commit, percentile-anchored values supersede the
defaults (e.g., 25/50/75/90 percentiles of Phase 3 Pacc-pos≥3 cumulative-input
distribution per ADR §3 row "P4-pre-2"). Substitution is mechanical, not a
re-deliberation.

### §7.4 Trial-fire authority

Per Phase 4 plan §4 line 96: orchestrator + user sign-off after V3 PASS + tag
commit. No trial fires before sign-off.

## §8 Failure Modes + Remediation

### §8.1 V3 FAIL diagnostic flow (ban-list trace)

The §6.5 ban-list classifier is the first triage. The eight categories
(ADR §4.6.10) cluster typical divergence sources:

| Ban-list item | Likely manifest categories that surface it |
|---|---|
| 1. Tokenizer truncation | 05 (over-cap), 08 (C1 small), 09 (C4 large) |
| 2. Wall-clock timestamp | All — leak appears in `METADATA` block |
| 3. Absolute path | All — leak appears in `METADATA` or `PRIOR_TURN` lines |
| 4. Session ID | All — leak appears in `METADATA` block |
| 5. CLI version | All — leak appears in `METADATA` block |
| 6. Filesystem enumeration order | 06 (multi prior turns) — sort breaks |
| 7. Hash/set iteration order | 06 (multi prior turns), 03 (Unicode keys) |
| 8. Locale-sensitive sort | 06 (multi prior turns) — non-`LC_ALL=C` sort breaks |

Order of investigation: read first 256 bytes of each impl's output; compare
`METADATA` block (catches items 2, 3, 4, 5 fast). Then check turn ordering
(catches 6, 7, 8). Then check truncation behavior (catches 1).

### §8.2 Iteration cap and architect escalation

If impl A and impl B do **not** converge after **N=3** rebuild attempts (per
project memory `feedback_evidence_based_bugfix.md` 3-attempt rule and
Constitution Rule 5 최선 — three failures = different LLM / different angle),
escalate to **architect** for ADR amendment.

Escalation payload:
- 3 divergence reports (one per failed iteration).
- Hypothesis: ADR §4.6 has an ambiguity on the divergence point. Cite the
  exact subsection (§4.6.5, §4.6.7, §4.6.9, etc.).
- Architect issues a **§4.6 clarification ADR** (or ADR rev3 to
  `2026-04-26-q1-prereq-redesign.md`). New normative wording lands in §4.6;
  V3 restarts from §5.3 freeze (manifests may need re-author if
  clarification expanded coverage).

This escalation is the path that protects against ADR ambiguity producing an
infinite remediation loop. It is also the path that surfaces "the spec is
incomplete" as a first-class failure mode rather than disguising it as
"the implementations are wrong."

### §8.3 Manifest set inadequacy

If V3 PASS but Phase 4c trials later expose a class of input that neither
manifest 1–10 covered, this work-spec did NOT govern that case. ADR §4.6.11
coverage list is the contract — if expanded, the contract changes (versioning
per §4.6.12 → `substitute-compact-v2`). Phase 4c trial-time mismatch with
expectations is itself an architect escalation; not a remediation under this
spec.

## §9 Constitution Check

| Rule | Where it applies in this spec | Verdict + line cite |
|---|---|---|
| **Rule 1 경량** (no over-engineering) | §3 chose Option A (subdir of existing `bin/lib/`) over Option C (new repo). Spec §1 explicitly carves out what it does NOT govern (no Layer 2 adapter, no harness rewiring). | PASS — `docs/superpowers/specs/2026-04-26-phase4c-v3-implementation-work-spec.md` §3.1 row "Constitution Rule 1 경량" + §1 "This spec does NOT" list. |
| **Rule 9 독립** (component standalone) | §3.1 row (a) verifies pure-function module has no runtime devkit dependency. §6.1 mandates harness session distinct from impl sessions — Rule 9 enforced at session-topology level. | PASS — §3.1 + §6.1. |
| **Rule 17 무의존** (no external plugin/library deps) | Spec mandates implementations use stdlib-only Python (no `tomli` for non-JSON, no third-party SHA-256, no third-party UTF-8 lib). Harness invokes only stdlib (`hashlib`, `json`, `pathlib`, `argparse`). | PASS — §6.2 invocation uses no third-party CLI flags; §10 INV-3 below restates as invariant. |
| **Rule 26 cross-OS** (bash via `lib/platform.sh`) | Harness is Python (cross-OS by stdlib choice), not new bash. No new bash code introduced. ADR §4.6 ban list item 8 (locale) + harness `LC_ALL=C` invocation handles the only OS-variability concern (sort locale). | PASS — §6.2 environment line. |

Constitution Rule 5 최선: §8.2 N=3 cap + architect escalation IS the Rule 5
discipline (3 failures → switch LLM / discipline). Not part of frontmatter
list but documented for reference.

## §10 Invariants (vs. ADR §4.6 — MUST NOT change without ADR amendment)

| ID | Invariant | Source |
|---|---|---|
| **INV-1** | Function signature `build_substitute_compact_stdin(manifest) -> UTF-8 bytes`. No model call, no tokenizer shellout, no out-of-manifest file reads. | ADR §4.6.2 line 247. |
| **INV-2** | Manifest schema = §4.6.3 fields exactly (12 top-level + 5 per-prior-turn). Implementations read by key, not object order. | ADR §4.6.3 lines 251–269. |
| **INV-3** | Length caps: setup=16,384; per-prior-task=8,192; per-prior-assistant=8,192 (last); preamble total=131,072 (drop oldest whole turns); current task=uncapped. UTF-8 boundary-safe. | ADR §4.6.7 lines 297–305. |
| **INV-4** | Eight-item ban list (`MUST NOT`): tokenizer truncation, wall-clock, absolute paths, session IDs, CLI versions, fs enumeration, hash/set order, locale sort. | ADR §4.6.10 lines 349–362. |
| **INV-5** | ASCII labels (case-sensitive, no Unicode): `SUBSTITUTE-COMPACT-V1`, `METADATA`, `SETUP_HISTORY_EXCERPT`, `PRIOR_TURN position=<n> fixture=<id> seed=<n>`, `PRIOR_USER_PROMPT_EXCERPT`, `PRIOR_ASSISTANT_OUTPUT_EXCERPT`, `CURRENT_TASK_PROMPT`. | ADR §4.6.8 lines 309–324. |
| **INV-6** | Manifest set = exactly 10 (§4.6.11 enumeration). Adding/removing requires `substitute-compact-v2` per §4.6.12. | ADR §4.6.11 lines 366–377 + §4.6.12 lines 381–383. |
| **INV-7** | V3 PASS = 10/10 byte-equal SHA-256. No partial-credit path. | ADR §9 row V3 line 583. |

Any change to INV-1 through INV-7 is an ADR amendment, not a work-spec edit.

## §11 Implementation Estimate

Wall-clock per phase (ranges; assumes one human-overseen day per phase max):

| Phase | Owner | Estimate (low–high) | Notes |
|---|---|---|---|
| Manifest authoring + review (§5.3 steps 1–2) | manifest-author session + 1 reviewer | 4–8 hours | Hand-authoring 10 manifests + fixtures hitting §5.2 coverage. Reviewer pass usually <2h. |
| §5.3 freeze commit | orchestrator | <30 min | Mechanical. |
| Impl A (§4) | aigentry-devkit-impl-a-claude | 4–8 hours | Codex review §2.4 estimated ~180–260 LOC for the summarizer. Pure function, normative spec → linear implementation work. |
| Impl B (§4) | aigentry-devkit-impl-b-codex | 4–8 hours | Same scope. Codex authored §4.6 spec — may be faster, but counts as independent. |
| Harness build (§6) | aigentry-devkit-v3-tester-claude | 2–4 hours | `v3-byte-equal-verify.py` is ~80–150 LOC stdlib-only. |
| V3 run (§6.2) | aigentry-devkit-v3-tester-claude | <5 min | 10 manifests, 2 impls = 20 invocations + SHA-256 = sub-minute. |
| Remediation buffer (§8) | (variable) | 0 hours (best) — 2 days (worst, before architect escalation) | If V3 PASS first try: 0. If ban-list violation: 2–4h per impl rebuild. If ADR-ambiguity escalation: open-ended (architect ADR amendment cycle). |

**Headline estimate**: 2–4 calendar days from manifest freeze to V3 PASS in the
nominal path. Worst case (ADR rev3 needed): adds the architect rev cycle
(typically 1–3 days for Q-track ADR loops per recent §6.4/§6.5 architect
failure-mode entries).

These are **planning estimates only** — Phase 1 spec does not commit to a
deadline. Orchestrator + user own scheduling.

## §12 Out of Scope

This spec deliberately excludes:

1. **Phase 4b replication arms** (D / S / Pfresh / Pacc × 20 seeds × 10 fixtures
   = 800 trials per Phase 4 plan §2.1). Phase 4b inherits the Phase 3 `-p`
   driver per ADR `docs/adr/2026-04-26-q1-prereq-redesign.md` §M1 — no new
   harness work.
2. **Phase 5 holdout** (5 new fixtures × 6 modes × 10 seeds = 300 trials per
   Phase 4 plan §2.3). Separate pre-registration tag
   `exec-mode-v5-holdout-preregistered-YYYYMMDD` per Phase 4 plan §4 line 95.
3. **Layer 2 cross-CLI adapter implementation** — Phase 6+ work per ADR §4.7.1
   line 397. The Phase 4+5 adapter is a Claude-only stub; this spec governs
   only the Claude-backed `build_substitute_compact_stdin` function, not its
   adapter wrapper.
4. **Codex Q2 work** (Codex `threshold_tokens` × `context_window` interaction)
   — tracker Q2 (`docs/research/open-questions-tracker.md:21–29`) is open and
   non-blocking for Phase 4 Claude-only execution. Cross-CLI cut equivalence
   blocks Phase 6+, not Phase 4c.
5. **Trial harness arm wiring edits** — ADR §4.5 line 218–229 lists mechanical
   edits to `bin/exec-mode-experiment.sh` etc.; orchestrator dispatches these
   separately (line 231 — "Orchestrator may dispatch to `aigentry-orchestrator-coder`").
6. **Phase 4d analysis spec** — Phase 4 plan §2.2 row 4d analyst best-cut
   selection is a separate downstream artifact.

## §13 Open Questions (defer to orchestrator / user)

| ID | Question | Default if unanswered | Cost of deferral |
|---|---|---|---|
| **OQ-1** | Should impl B be **codex** (as recommended in §4.1) or **claude-cold** (a second fresh Claude session with no shared parent)? Codex authored §4.6 spec; some independence purists prefer claude+claude-cold to remove that potential edge. | Use codex per §4.1. | Low — convergence is the desired outcome; spec-author bias would push toward MORE convergence, not less, which is what V3 measures. |
| **OQ-2** | Does the manifest-author session (§5.3 step 1) count toward V3 independence? It writes the inputs both impls consume. | Treat as a **third** independent role (not impl A, not impl B, not tester). Spec authoring ≠ implementation. | Low — manifest authorship is bounded by §5.2 coverage criteria + §5.3 step 2 review. Manifest bytes ≠ implementation bytes. |
| **OQ-3** | Should the pre-registration tag also embed the **manifest commit hash** (§5.3 step 3) and the **two impl source commit hashes**, or only the SHA-256 digests? | Embed all three (manifest freeze commit + impl A commit + impl B commit + 10 SHA-256 digests) in the annotated tag message. | Medium — hash-only tag is auditable; commit-embedded tag is auditable + reproducible. Embedding is cheap; recommend embed. |
| **OQ-4** | Does P4-pre-2 (analyst transcript-size pull) need to land before tag commit, or is the default cut grid (10k/50k/100k/150k) acceptable for the experiment to begin? | Default grid is acceptable per Phase 4 plan §2.2 footnote. | Low — F-Q1 (cut sensitivity follow-up, Phase 4 plan §6 line 118) covers ±20% sensitivity post-hoc. |
| **OQ-5** | Code-location decision §3.2 commits to `aigentry-devkit/bin/lib/preuse_substitute_compact/` without verifying repo state (per dispatch constraint "DO NOT read aigentry-builder/ or aigentry-devkit/ source code"). Is the path **reachable** in the current devkit layout (i.e., is `bin/lib/` the actual lib root, vs. just `lib/` or another convention)? | Architect recommends Option A per §3 reasoning. If path proves wrong on dispatch, impl A or impl B reports STUCK and orchestrator dispatches a follow-up architect run for path correction (impl plan unchanged otherwise). | Low — path is mechanical; a 2-line architect correction is sub-hour. The structural decision (subdir of devkit/lib, not new repo, not builder) is the load-bearing claim. |

OQ-1 and OQ-2 are **independence-protocol** questions; OQ-3 is a
**reproducibility** question; OQ-4 is a **scheduling** question; OQ-5 is a
**path-verification** question. None block Phase 1 spec approval; all benefit
from explicit orchestrator/user disposition before Phase 2 implementation
dispatch.
