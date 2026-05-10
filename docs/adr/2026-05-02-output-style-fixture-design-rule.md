---
type: adr
status: accepted
accepted_date: 2026-05-02
accepted_by: orchestrator (oikim signoff via aigentry-orchestrator)
scope: ecosystem
decision_type: one-way
date: 2026-05-02
author: aigentry-architect-phase6-q3-adr
revision: r3
previous_revision: c73565c
r2_basis: codex-aed61e8 + gemini-b1bcf74
r3_basis: codex-b06584b (R2-N1 PyYAML→JSON migration + R2-N2 grandfathered field-overload fix)
tags: [fixture-design, grader-rubric, output-style, formatting-exemption, exec-mode, phase6, q3]
supersedes: []
related:
  - docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md
  - docs/superpowers/specs/2026-05-02-phase6-design.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-final-analysis.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-gemini-review.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-02-q3-adr-codex-review.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-02-q3-adr-gemini-review.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-02-q3-adr-r2-codex-review.md
  - ~/projects/aigentry-devkit/docs/reports/2026-05-02-q3-adr-r2-gemini-review.md
related_tasks: [329]
constitution_rules: [Article 1 경량, Article 13 비판적+건설적+객관적, Article 17 무의존, Article 18 벤치마크 우선 디버깅]
parent_track: "#329 E27 Phase 6 Q3 (per Phase 6 spec §2.3 + §10.3, parallel-dispatch with Q4)"
---

# ADR — Output-style Fixture-Design Rule (formatting-exemption MUST)

## §1 Context

### §1.1 Trigger

Phase 5 holdout (devkit `c8478b4`, 2026-05-01) attempted to surface mode-asymmetric output-style bias on fixture **H5** (agentic-tool-use). Three converging signals motivated this rule:

1. **Phase 5 final analysis NB3** (devkit `docs/reports/2026-05-01-phase5-final-analysis.md` §7 — H5 modes scored q=1.000 in 5/6 modes; only Pfresh had a single 0.967 outlier). The hypothesized PC-vs-S asymmetry on backtick-wrapped tool-call enumerations did not materialize on the actual H5 dataset, but only because the agents produced uniform formatting in this run. The grader did NOT implement formatting-exemption; the bias remained latent and dormant. T-2 known-issue acceptance (Phase 5 spec §5.4) was tactically correct but exposed the structural risk.
2. **Gemini Phase 5 review D3** — two related statements from the same reviewer:
   - **§6 (rule statement, verbatim)**: "Fixture design must implement formatting-exemption logic in graders for structurally equivalent data (e.g., extracting JSON from raw text vs markdown block)."
   - **§10 row D3 (top-3 condition restatement, verbatim)**: "Establish an 'output-style formatting exemption' standard for future fixture design to avoid the NB3-style over-correction loops encountered in Phase 5."
   Both at devkit `docs/reports/2026-05-01-phase5-gemini-review.md`. D3 is one of three top-priority conditions for the Phase 5 final ADR (D1/D2/D3).
3. **Parent ADR §11 item 3** (`docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` Phase 6 stub) — pre-registered the rule as a Phase 6 binding deliverable: "graders for structurally-identical data (e.g., JSON in raw text vs in markdown block) MUST implement formatting-exemption logic."

### §1.2 Phase 6 spec scope

The Phase 6 spec (`docs/superpowers/specs/2026-05-02-phase6-design.md`, Accepted 2026-05-02) declares this rule as **Q3** (§2.3, §3.3, §6.3, §10.3). Q3 is intentionally **decoupled** from Phase 6 trial firing (Q1/Q2/Q4): trial outcomes do not gate this rule, and this rule's acceptance does not depend on Q1/Q2/Q4 outcomes. Per spec §10.3 + §11 item 3, the Q3 ADR is dispatched in parallel with Q4 dustcraw fixture authoring; per spec §3.3, the rule applies to all future fixture authors regardless of Phase 6 main-result direction.

**Tier escalation note (vs Phase 6 spec §3.3)**: Phase 6 spec §3.3 declared Q3 as **Tier T1 / cross-project / 1 reviewer**. This ADR's frontmatter sets `scope: ecosystem` (which the architect frontmatter-schema maps to **Tier T2 / 2 reviewers**) on the basis that the rule binds *all* future fixture authors across the entire devkit + dustcraw + analyst chain — not merely 2 named projects. Operationally this means orchestrator should dispatch 2 reviewers (T2 default per `references/frontmatter-schema.md`), not 1 (Phase 6 spec §3.3 T1 default). The escalation does not alter the rule wording, scope, or enforcement; it only raises the reviewer count. Orchestrator may amend Phase 6 spec §3.3 in a Phase 6 conclusion ADR if T1↔T2 reconciliation is required for spec consistency.

#### §1.2.1 Tier classification rationale (r2 — addresses codex T2-needs-3rd-reviewer concern)

The c06c93c (r1) review round produced a **tier disagreement**: codex returned `T2-needs-3rd-reviewer` while gemini returned `T2-pass`. This subsection resolves the disagreement on the record per task hard-rule.

**Codex tier concern (verbatim, codex review §4)**:

> Reviewer sufficiency:
> - A codex review plus a spec-document-reviewer can count as two perspectives only if the spec-document-reviewer is independent of the ADR author and its report is archived as a review artifact.
> - If the spec-document-reviewer was a Claude subagent adjacent to a Claude architect author, this does not cleanly satisfy the self-review exclusion principle (`reviewer-matrix.md:50-57`).
> - Because this review finds enforcement-mechanics blockers and the T2 default expects gemini for edge cases, I recommend one post-revision gemini review before final signoff.
> Tier verdict: T2-needs-3rd-reviewer.

**Gemini tier verdict (verbatim, gemini review §5)**:

> The spec designated this as T1, but the ADR escalated it to T2 (ecosystem scope). This is highly defensible. ... Accept the T2 tier classification. The ecosystem-wide impact on evaluation rigor justifies the requirement for two reviewers.

**Resolution (this ADR, r2)**: Tier remains **T2** with the following clarification of reviewer counting:

1. **T2 threshold per `references/frontmatter-schema.md` line 67–69**: `adr + ecosystem + *` → T2 → 2 reviewers. The schema does not require a 3rd reviewer for `scope: ecosystem`; T3 is reserved for `scope: constitutional + decision_type: one-way` only.
2. **Cross-LLM reviewer count for r1**: the r1 round was reviewed by **codex (aigentry-reviewer-q3-adr-codex)** + **gemini (aigentry-reviewer-q3-adr-gemini)** = 2 cross-LLM perspectives. The T2 threshold is **mechanically satisfied**.
3. **spec-document-reviewer role**: the claude spec-document-reviewer subagent is a **pre-submit self-check loop** (per superpowers:brainstorming Step 7), not a counted reviewer toward T2. Codex is correct that the subagent cannot substitute for an independent cross-LLM perspective. This ADR adopts codex's clarification: the subagent is **supplemental, not a replacement** for cross-LLM reviewers.
4. **r2 re-review scope**: the r2 changes are **targeted blocker fixes** (not redesign — rule wording §2.1 unchanged, decision §2 architecture unchanged, only enforcement-mechanism details §2.4 + registry schema §11 + fallback rules §7.4 changed). Whether r2 requires a full cross-LLM re-cycle vs. spec-document-reviewer-only PASS is **delegated to orchestrator decision** per task spec — see §14 r2 follow-up recommendation.

**Tier disposition**: T2 with codex + gemini cross-LLM reviewers (r1 round) + claude spec-document-reviewer subagent (pre-submit self-check) — threshold satisfied. T3 escalation is **not required** because `scope: ecosystem` ≠ `scope: constitutional`. Phase 6 spec §3.3 amendment (T1 → T2) is a separate housekeeping item to be addressed in a Phase 6 conclusion ADR.

**Note on `accepted_date` field convention**: This ADR's frontmatter currently contains only `date: 2026-05-02`. Upon user signoff, the orchestrator (or successor architect session) will add `accepted_date: YYYY-MM-DD` and `accepted_by: ...` to the frontmatter, matching the parent ADR + Phase 6 spec convention. The §2.3 row 1 cutoff phrase "this ADR's `accepted_date`" refers to the date the ADR transitions to `status: accepted` and acquires that frontmatter field.

### §1.3 Evidence summary

- [REF: devkit `docs/reports/2026-05-01-phase5-final-analysis.md` §7] — NB3 H5 case, 5/6 modes at q=1.000, latent-bias documentation.
- [REF: devkit `docs/reports/2026-05-01-phase5-gemini-review.md` §6 + §10 D3] — verbatim D3 condition.
- [REF: orchestrator `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` §11 item 3] — pre-registered Phase 6 stub (≤300 words binding scope).
- [REF: orchestrator `docs/superpowers/specs/2026-05-02-phase6-design.md` §2.3 + §3.3 + §6.3 + §10.3] — Accepted spec binding Q3 as standalone ADR with verbatim rule wording.
- [REF: devkit `state/fixtures/phase5-holdout/H5/ground_truth.json`] — H5 grader checks tool-palette membership, ordering invariants, argument citations, phantom-tool penalty. None of these checks normalize backtick-wrapping or markdown-fence variants; the bias surface is structural to the grader, not surfaced in this run only because output formatting happened to be uniform.

### §1.4 Existing-mechanism check (anti-reimplementation)

| Capability | Already exists | Location |
|---|:-:|---|
| Reviewer-checklist mechanism (cascade-grader-rubric) | YES | Phase 5 cascade-13a/b/c/d in `~/projects/aigentry-devkit/docs/reviews/` |
| Grader emits per-trial JSON metrics | YES | All Phase 3+ graders emit `metrics.json` per trial (schema_version=1) |
| Pre-tag harness commit-SHA freeze | YES | Pre-reg tag annotations include grader SHA per Phase 5 spec §5.1 item 9 |
| CI lint for repository invariants | NO | aigentry-devkit has tagging discipline but no per-grader lint script today |
| Exemption registry for fixture-rule grandfathering | NO | First instance of an ecosystem-level grandfathering registry |

The first three are reused (no reimplementation). The CI lint script and exemption registry are new artifacts; both stay minimal (single shell/python script + single markdown registry) per Article 1 경량.

## §2 Decision

### §2.1 Rule statement (verbatim, mandatory wording)

**The following sentence is the binding rule. Any binding downstream artifact that restates this rule MUST quote the binding sentence verbatim** (codex MINOR 1 — non-binding prose MAY summarize while citing this ADR by ID):

> Graders for structurally-equivalent data variants **MUST** implement a formatting-exemption equivalence pre-step before scoring; edge cases require explicit exemption documentation in the grader spec.

**"Binding downstream artifact"** means: cascade-grader-rubric reviewer checklist items (§2.4.1), pre-tag lint script error messages (§2.4.3), exemption-registry rationale fields (§11), Phase 6+ spec sections that gate trial-fire on this rule. **Non-binding prose** (analyst reports, retrospectives, planning notes, brainstorming transcripts) MAY paraphrase as long as it cites this ADR by ID.

This wording is taken verbatim from Phase 6 spec §2.3.1 (Accepted 2026-05-02 by oikim via aigentry-orchestrator-claude). It supersedes the parent-ADR §11 item 3 paraphrase ("graders for structurally-identical data ... MUST implement formatting-exemption logic") which was a stub-length pre-registration; the Phase 6 spec wording is the durable binding form.

**Scope clarification — structural vs semantic equivalence (r2, addresses gemini MINOR 2 + codex edge-case §5.2)**:

This rule covers **structural / formatting / wire-format equivalence** of the *same data*. It does NOT cover **deep semantic equivalence** of *different implementations* producing the same outcome.

| In scope (rule applies) | Out of scope (rule does not apply) |
|---|---|
| JSON inside ` ```json ` fence vs raw JSON (same object) | `for` loop vs `while` loop computing the same result |
| Backtick-wrapped vs unwrapped identifier (same symbol) | Two equivalent SQL queries with different syntax |
| YAML vs JSON serialization (same key-value mapping) | Two valid sort algorithms producing the same sorted array |
| Bullet vs numbered list (same items, when grader compares items) | Recursive vs iterative implementation of the same function |
| Tool-call rendering wrapper variants (same tool name + args) | Different prose explanations of the same concept |

**Rationale**: The Phase 5 NB3 case (analyst §7) identified bias on **wrapper formatting** of structurally-identical data. Deep semantic equivalence of different code/logic implementations is a separate concern (semantically-equivalent code may legitimately differ in scoring under task-specific rubrics). A future ADR may extend coverage to semantic-equivalence if a Phase 6+ analyst finding surfaces such bias; this ADR scopes only the formatting layer.

"Structurally-equivalent data variants" examples (illustrative, non-exhaustive):

- JSON inside a markdown ` ```json ` fence vs raw JSON in the same response.
- Bullet list (`- foo`) vs numbered list (`1. foo`) when the grader compares the *items*, not the enumeration style.
- Backtick-wrapped identifiers (`` `func_name` ``) vs unwrapped (`func_name`) when the grader compares the *symbol*, not the typography.
- A dictionary serialized as JSON vs as YAML when the grader compares the *key-value mapping*, not the wire format.
- Tool-call rendering: `tool_name(arg)` vs ` `tool_name(arg)` ` vs ` ```call \n tool_name(arg) \n``` ` when the grader checks tool palette membership / ordering / arguments, not the markdown wrapper (this is the H5 case directly).

### §2.2 Wording strictness — why MUST (RFC 2119)

"MUST" (RFC 2119 strong-imperative) is chosen over "SHOULD" or "case-by-case discretion" for three evidence-anchored reasons:

1. **Empirical cost of the weaker form** — Phase 5 NB3 demonstrated that absent an explicit equivalence pre-step, the grader's correctness on a fixture is contingent on the agents *happening* to emit uniform formatting in that run. The bias is dormant, not absent (analyst §7.3 verbatim: "the latent bias is dormant and unobservable in this dataset"). Lighter wording invites silent regression in the next phase that uses an H5-class fixture.
2. **Auditability** — MUST is mechanically checkable (does the grader code contain a canonicalization step? does it emit `formatting_exempt_status` ∈ {implemented, not_applicable, grandfathered}? does the reviewer checklist include the item?). SHOULD or case-by-case requires reviewer judgment per fixture, which is not auditable at scale across 4+ new fixtures per phase.
3. **Track record on weaker pre-registrations** — codex C3 (Phase 5 review) flagged that non-binding pre-registrations have produced post-hoc rationalizations in prior phases; making this rule MUST aligns with the Phase 6 binding-pre-reg discipline.

### §2.3 Scope of MUST (forward-binding + grandfathering)

The MUST applies as follows:

| Fixture cohort | MUST applies | Compliance path |
|---|:-:|---|
| **NEW fixtures authored on or after this ADR's `accepted_date`** (e.g., H11–H14, all Phase 6+ dustcraw deliverables) | YES (binding) | Author satisfies §2.4 enforcement before grader cross-LLM review; pre-tag lint check (§2.4.3) blocks tag commit on violation. |
| **Existing fixtures with an in-flight required patch BEFORE Phase 6 pre-reg tag** (currently: **H1** — NB3 patch required per Phase 6 spec §4.1 line 271 + §10.4 line 358–361) | YES on the patch (r2 — codex MAJOR 4) | Registry status: `pending-migration` with **hard deadline = Phase 6 pre-reg tag** (~2026-05-late). The NB3 patch session MUST also satisfy §2.4 in the same iteration. Lint smoke example MUST NOT use H1 as a durable `false` exemplar. |
| **Existing reused fixtures from Phase 3–5 with NO in-flight patch** (currently: **H10**) carrying forward their current grader behavior | NO (grandfathered with hard deadline) | Listed in **Exemption Registry** (§11) with `expiry: 2026-08-01` (gemini D1 — Phase 7 deadline aligning with Pacc sunset window). Reuse permitted at current grader behavior until expiry; lint MUST fail-closed on expired entries. |
| **Existing fixtures whose grader receives ANY non-trivial patch** (e.g., any future scoring-logic change to H10) | YES on the patch | When a grandfathered grader is patched for any reason, the patched grader MUST satisfy §2.4 (no incremental free pass). |
| **Pre-Phase 6 fixtures that have already been retired** (H2, H3, H5 — replaced per Phase 6 spec §4.2) | N/A | Not in scope; if any retired fixture is later un-retired, treat as NEW per row 1. |

### §2.4 Enforcement mechanisms (all three required, per gemini D3)

The rule is enforced by **three complementary mechanisms** operating at distinct lifecycle stages. All three are required; any one alone is insufficient. Per task hard-rule "Cross-reference all 3 enforcement mechanisms".

#### §2.4.1 Reviewer checklist (cascade-grader-rubric — pre-grader-acceptance gate)

The cascade-grader-rubric review template (Phase 5 cascade-13 pattern) gains the following two items, in this exact phrasing, in the section currently containing the per-grader rubric checks:

> - [ ] **Output-style exemption verified** — Does the grader emit `quality.primary_components.formatting_exempt_status` ∈ {`implemented`, `not_applicable`, `grandfathered`} per ADR `2026-05-02-output-style-fixture-design-rule.md` §2.4.2? For `implemented`: cite the canonicalization function name (matches `formatting_exempt_canonicalizer` field) and quote the source line range. For `not_applicable`: cite the grader docstring `formatting_exempt_justification` section verbatim. For `grandfathered`: cite the §11 registry entry by `fixture_id`.
> - [ ] **Equivalence-surface declaration** (r2 — codex §2.1 false-negative tightening) — Does the grader carry a fixture-local "equivalence surface" declaration (e.g., docstring section or comment block) listing (a) variants the canonicalizer normalizes AND (b) semantic-format surfaces deliberately NOT normalized? List both.
> - [ ] **Adversarial output-style cases included** — Does the grader's test suite include at least one positive case AND one negative case for each variant declared in the equivalence surface (e.g., raw-JSON vs markdown-fenced JSON; backticked vs unwrapped identifiers; fenced JSON with prose preamble; mixed table/code-block outputs)? List the test names (matches `formatting_exempt_tests` field). **MUST mark BLOCK if `formatting_exempt_status: implemented` but no positive AND negative adversarial tests exist** (r2 — codex §2.1 BLOCK criterion).

Reviewer authority: cascade-grader-rubric session (claude or codex or gemini, rotated per Phase 5 cascade-13 pattern). The reviewer MUST mark BLOCK if either item is unchecked without an exemption-registry entry citation.

#### §2.4.2 Grader-internal status field (`formatting_exempt_status`) — per-trial audit (r2 — addresses codex BLOCKER 1 + BLOCKER 2 + MAJOR 2)

**r2 redesign rationale**: The r1 design proposed a top-level `metrics.json` boolean. Codex review (BLOCKER 1) verified this is **incompatible with the current devkit harness**: `state/schema/metrics.v1.json:24` declares `"additionalProperties": false` at top level, and `bin/exec-mode-experiment.sh:680-686` validates the assembled payload against that schema before write. Adding a top-level field would require a schema patch + harness patch coordinated change. r2 chooses the **lighter path**: relocate the field under `quality.primary_components`, which the schema declares as a free-form object (`metrics.v1.json:156-159`: "Free-form per-fixture grader sub-scores"). The harness already passes the grader's return dict directly into `quality.primary_components` (`bin/exec-mode-experiment.sh:825`: `quality_components = qual_raw if isinstance(qual_raw, dict) else None`), so adding a key to the grader's return dict requires **zero harness or schema patches**.

Codex BLOCKER 2 also surfaced an inconsistency between the boolean-only contract and the §9.2 edge-case path (formatting IS the scoring surface). r2 replaces the boolean with a **status enum** that operationally distinguishes the three legitimate states.

**r2 contract**:

Every primary grader function (the one whose output enters `quality.primary` per codex C4 endpoint discipline) MUST include in its return dict (which lands at `metrics.json::quality.primary_components`):

```json
{
  "formatting_exempt_status": "implemented" | "not_applicable" | "grandfathered",
  "formatting_exempt_canonicalizer": "<function-name-or-null>",
  "formatting_exempt_variants": ["<variant-1>", "<variant-2>", ...],
  "formatting_exempt_tests": ["<test-name-1>", "<test-name-2>", ...],
  "formatting_exempt_rule_adr": "2026-05-02-output-style-fixture-design-rule"
}
```

**Status semantics**:

| Status | Meaning | Required companion fields |
|---|---|---|
| `implemented` | Grader implements a canonicalization/normalization step before scoring | `canonicalizer` = source function name (e.g., `_canonicalize_tool_call`); `variants` = list of normalized wrapper variants; `tests` = list of adversarial unit-test names |
| `not_applicable` | Formatting IS the scoring surface (e.g., markdown-rendering correctness, strict-format JSON validation), so canonicalization would defeat the test | `canonicalizer` = `null`; `variants` = `[]`; `tests` = `[]`; grader docstring MUST contain `formatting_exempt_justification` section explaining why formatting is the scoring surface |
| `grandfathered` | Pre-Phase 6 fixture in §11 registry; migration deferred per registry expiry | `canonicalizer` = `null`; `variants` = `[]`; `tests` = `[]`. The `formatting_exempt_status` field value MUST literally be the string `"grandfathered"` (NOT a fixture slug). Lint check 3 (§2.4.3) performs the registry cross-check by reading the **trial's existing top-level `fixture_id`** (or `quality.primary_components.fixture` if that is the chosen identifier source) and verifying it has an active (non-expired) entry in §11 with status `grandfathered` or `pending-migration`. (r3 — addresses codex R2-N2: do not overload `formatting_exempt_status` with a fixture slug.) |

Hard rule: **NEW fixtures (per §2.3 row 1) MUST emit `implemented` OR `not_applicable`**. NEW fixtures with `grandfathered` are a hard-block at lint (§2.4.3 check 4). The §9.2 edge-case path (formatting-as-scoring-surface) is operationally accommodated by `not_applicable` — the conflict codex BLOCKER 2 identified is resolved.

**Field location confirmation**: `metrics.json::quality.primary_components.formatting_exempt_status` (NOT top-level). Harness assembly reference: the grader's `score-fixture` JSON return is stored verbatim in `quality.primary_components` per `bin/exec-mode-experiment.sh:825`. No schema patch required (r2 — addresses codex BLOCKER 1).

**Backward-compat**: Existing analyst aggregation scripts that don't read `quality.primary_components.formatting_exempt_*` continue to work unchanged. The free-form sub-object accepts new keys without schema modification (`metrics.v1.json:156-159`). Phase 3–5 historical metrics.json files (without these fields) remain valid (the field absence is interpreted by lint as `not_emitted`, which is handled per §2.4.3 check 1).

#### §2.4.3 Pre-tag orchestrator-invoked lint check — pre-registration tag commit gate (r2 — addresses codex MAJOR 1, MAJOR 5, MINOR 2)

**Terminology (codex MINOR 2)**: This ADR uses "**orchestrator-invoked pre-tag lint**" consistently. There is no hosted CI runner; the lint is invoked by the orchestrator session as a pre-condition before signing off on a pre-registration tag commit. (r1 used "CI" loosely; r2 removes that ambiguity.)

Before any pre-registration tag commit (e.g., `exec-mode-vN-preregistered-YYYYMMDD` per Phase 5/6 spec §8.1), a lint script MUST execute the following four checks against each in-scope primary grader. **r2 strengthens lint from regex-source-only to AST+smoke+JSON inspection** (codex MAJOR 1: regex-only lint can pass on comments, dead branches, no-op canonicalizers, or fields nested under wrong key).

**Lint check set (all four required)**:

| # | Check | Method | Pass criterion |
|---|---|---|---|
| 1 | **Field emission** | Run a smoke `score-fixture` invocation against a tiny canned input per fixture; parse the resulting `metrics.json` (or grader return JSON); verify `quality.primary_components.formatting_exempt_status` is present and equals one of the three enum values | Field present + valid enum value |
| 2 | **Status-companion-field consistency** | For `implemented` status: verify `canonicalizer` ≠ `null` AND `variants` non-empty AND `tests` non-empty AND the named function exists in grader source (Python `ast` walk) AND the named tests exist in the grader's test file (Python `ast` walk on `def test_*`) | All four sub-checks pass |
| 3 | **Registry consistency for `grandfathered`** | For each grader emitting `formatting_exempt_status: "grandfathered"`: parse the §11 registry (machine-readable JSON block per r3 — see §11; loaded via Python stdlib `json.load`); read the **trial's top-level `fixture_id`** from the same `metrics.json` (NOT the `formatting_exempt_status` field, which always equals the literal string `"grandfathered"`); verify that `fixture_id` has an active (non-expired) entry in the registry with `status` ∈ {`grandfathered`, `pending-migration`} AND `lint_allow_status_grandfathered: true` for `grandfathered` (per §11 entry contract). (r3 — codex R2-N1 + R2-N2 fix.) | Registry entry exists, not expired, status compatible, `lint_allow_status_grandfathered` honored |
| 4 | **NEW-fixture hard block** | For each grader corresponding to a NEW fixture (per §2.3 row 1; NEW = registry has NO entry for the fixture_id): verify status ∈ {`implemented`, `not_applicable`}. Status `grandfathered` is forbidden for NEW fixtures | Status ∈ {implemented, not_applicable} |

**False-positive defense** (codex MAJOR 1 — what could pass regex-only lint but fail the rule):

- **Comment / docstring containing the field name** → defeated by check 1 (parses actual emitted JSON, not source text).
- **Dead branch returning the field** → defeated by check 1 (smoke run exercises the actual primary scoring path).
- **Field emitted under wrong nesting (e.g., top-level by mistake)** → defeated by check 1 (looks specifically at `quality.primary_components.formatting_exempt_status`).
- **`implemented` with no-op canonicalizer** → defeated by check 2 (requires named canonicalizer function reachable in source AND named adversarial tests existing in test file).
- **Trial fixture_id without registry coverage when `grandfathered` is emitted** → defeated by check 3 (cross-checks the trial's top-level `fixture_id` against the registry; per r3, the `formatting_exempt_status` field is NOT a slug carrier, so this is a strict registry-existence check on the trial's own identifier).
- **NEW fixture sneaking `grandfathered`** → defeated by check 4.

**Script artifacts** (specified here, implemented by a coder session per §8.3):

- **Script path**: `~/projects/aigentry-devkit/bin/lint-formatting-exemption.py` (Python preferred over bash because checks 1–2 require AST analysis and JSON parsing; codex OQ4 default for non-trivial scripts).
- **Dependencies**: Python stdlib only (`ast`, `json`, `pathlib`, `subprocess` for smoke run). The registry is JSON (§11), parsed by `json.load`. **No PyYAML** — Article 17 무의존 stdlib-only path. (r3 — addresses codex R2-N1: `~/projects/aigentry-devkit/requirements-exec-mode.txt` does NOT include `pyyaml`; r2 incorrectly claimed it as a baseline. JSON eliminates the dependency entirely.)
- **Behavior**: exit 0 = pass (tag commit may proceed); exit non-zero = fail with per-grader diagnostic (which grader, which check failed, what the grader emitted vs what was expected, file path + line number). Diagnostic format MUST be machine-parseable for orchestrator follow-up dispatch.
- **Smoke-run input**: each grader carries (or the lint script provides) a minimal canned `agent_output` + `ground_truth` pair sufficient to exercise the primary scoring path. This canned input lives at `~/projects/aigentry-devkit/tests/exec-mode/lint-smoke/<fixture_id>.json` (created by §8.3 coder task).
- **Invocation point**: orchestrator pre-tag pre-condition checklist (Phase 6 spec §8.3 add a 7th item: "`bin/lint-formatting-exemption.py` exit 0").

**No silent regex fallback** (r2 — addresses codex MAJOR 1 directly): The lint MUST NOT degrade to source-grep when AST or smoke-run fails — it MUST fail closed and surface the failure mode to the orchestrator.

Article 1 경량: no Github Actions / CircleCI / etc. introduced. Article 17 무의존: Python stdlib only (r3 — registry is JSON; PyYAML eliminated).

## §3 Alternatives Considered

### §3.1 Alternative A — SHOULD wording (advisory)

- **Description**: Replace MUST with SHOULD in §2.1; reviewer judgment per fixture.
- **Pros**: Lower compliance friction; allows grader authors flexibility on edge fixtures (e.g., a fixture where formatting is the scoring surface, like a markdown-rendering test).
- **Cons**: Phase 5 NB3 evidence (analyst §7.3 dormant-bias documentation) shows that latent bias survives advisory wording — the grader either normalizes or it doesn't, and SHOULD doesn't tip the default. Reviewer judgment per fixture is unauditable across 4+ new fixtures per phase. Codex C3 binding-pre-reg discipline argues against soft pre-registrations.
- **Rejection reason**: Empirical cost (NB3 case + dormant-bias risk on H11–H14 reuse) outweighs the friction cost of MUST.

### §3.2 Alternative B — Single enforcement mechanism (reviewer checklist only)

- **Description**: Adopt §2.4.1 reviewer checklist as the only enforcement; drop the grader-internal flag (§2.4.2) and pre-tag lint check (§2.4.3).
- **Pros**: Lightest implementation; matches existing cascade-13 pattern with zero new artifacts.
- **Cons**: Single-checkpoint enforcement (the reviewer step) is bypassable when reviewer rotation falls back to a less-rigorous reviewer or under time pressure (Phase 5 §5.4 T-2 known-issue process is precedent). Defense-in-depth principle (project CLAUDE.md security best-practices) argues for redundant enforcement at distinct lifecycle stages.
- **Rejection reason**: Gemini D3 explicitly named the rule needing **both** a reviewer enforcement and an automatable check ("avoid NB3-style over-correction loops"). Single-mechanism enforcement does not satisfy D3's intent.

### §3.3 Alternative C — Grader-flag-only enforcement (no reviewer checklist, no CI check)

- **Description**: Adopt only §2.4.2 (grader emits `formatting_exempt_status`); rely on post-hoc analyst inspection to detect violations.
- **Pros**: Zero process change for reviewers; analyst reports already inspect `metrics.json`.
- **Cons**: Post-hoc detection is too late — the violation surfaces only after trials fire, which means a contaminated dataset and re-fire cost. Phase 5 NB3 analyst §7 is the cautionary case: NB3 was *detected* post-hoc but the T-2 acceptance was forced by the timing of detection.
- **Rejection reason**: Pre-fire prevention (reviewer + pre-tag lint) is strictly cheaper than post-fire detection + re-fire (Phase 5 trial-cost evidence: ~10 hours wall per re-fire cycle).

### §3.4 Alternative D — Apply MUST retroactively to all Phase 3–5 fixtures (no grandfathering)

- **Description**: §2.3 requires every reused fixture (H1, H10) to be patched to satisfy §2.4 before any Phase 6 use; no exemption registry.
- **Pros**: Single rule, no carve-outs, maximum consistency.
- **Cons**: Phase 6 timeline impact — H1 grader patch (NB3 already in flight) plus full canonicalization rewrite would block Phase 6 pre-tag for an additional cascade-grader-rubric review cycle per fixture (~5 iterations per Phase 5 §5.4 precedent). Article 1 경량: the cost is disproportionate to the marginal risk on grandfathered fixtures whose graders have already been validated through Phase 3/4/5 cycles.
- **Rejection reason**: §11 exemption-registry approach trades a small short-term risk (pre-Phase 6 fixtures retain dormant-bias surface) for a large schedule cost (Phase 6 fire delay). Registry tracks the debt for explicit later repayment per §8.1 milestone-row 4 + §9 OQ1.

### §3.5 Chosen — §2.4 three-mechanism enforcement + §2.3 grandfathering with registry

Rationale: combines reviewer-stage + grader-stage + pre-tag-CI-stage enforcement (defense in depth, satisfies gemini D3) with bounded rollout cost (grandfathering registry prevents Phase 6 schedule disruption). See §4 trade-off matrix for weighted comparison.

## §4 Constitution Check

Per `references/constitution-check.md` §1 (5 mandatory questions). Scope is `ecosystem` (not `constitutional`), so 18-article transverse audit is not required, but the four most-load-bearing articles are answered explicitly per the dispatch task hard-rule "위헌 심사".

### Q1 (제14조 범용/멀티크로스): AI 기술 격차 해소에 복무하는가?

**PASS** — The rule applies to grader authors (who are typically dustcraw or coder sessions, not end users); the end-user surface is unaffected. The rule's downstream effect is *more reliable benchmarking*, which strengthens the empirical foundation for Rule 4-A Step 4 mode-selection decisions that all aigentry users transitively benefit from.

### Q2 (제3조 컴포넌트 역할): 이 기능은 어느 컴포넌트의 역할인가?

**PASS** — The rule lives in three component-correct locations:

- **Rule statement (this ADR)**: aigentry-orchestrator (architectural decision, durable rule home).
- **Reviewer checklist**: aigentry-devkit `docs/reviews/` (cascade-grader-rubric template lives there per Phase 5).
- **Grader-internal status field + pre-tag lint**: aigentry-devkit `tests/exec-mode/graders/*` + `bin/lint-formatting-exemption.py` (graders + harness lints belong to devkit). r2: lint script extension `.py` per §9.4 resolution.

No component-role침범: orchestrator records the decision; devkit implements + enforces. Fixture authors (dustcraw) consume the rule via spec.

### Q3 (제1조 경량 + 제17조 무의존): 이 프레임워크/라이브러리가 정말 필요한가?

**PASS** — No new dependencies; uses Python stdlib only (r3 — addresses codex R2-N1; r2's pyyaml claim was factually incorrect — verified absent from `~/projects/aigentry-devkit/requirements-exec-mode.txt` and `.venv-exec-mode`). Implementation primitives:

- Reviewer checklist: markdown line additions to existing template.
- Grader-internal status field: additive sub-field within existing `metrics.json::quality.primary_components` free-form object (r2 — relocated from top-level per BLOCKER 1 fix; schema_version=1 stays unchanged; no schema patch required).
- Pre-tag lint (orchestrator-invoked, §2.4.3): Python stdlib only (`ast`, `json`, `pathlib`, `subprocess`). Registry parsed via stdlib `json.load`. No new dependency introduced. No hosted CI runner.
- Exemption registry: single machine-readable file at `~/projects/aigentry-devkit/state/fixtures/_exemption-registry.json` (r3 — JSON for stdlib-only Article 17 무의존; codex MAJOR 3 machine-readable requirement satisfied by JSON equally well).

Article 1 경량 satisfied: total new code surface ≤ ~80 LOC python + ~30 lines JSON registry + ~10 lines markdown checklist. Article 17 무의존 satisfied: zero new external libraries — pure Python stdlib + standard markdown/JSON only.

### Q4 (제2조 크로스): 모든 크로스 환경에서 동작하는가?

**PASS** — All artifacts are Python-stdlib + plain markdown/JSON; harness invocation is POSIX-shell-compatible. macOS / Linux / Windows-WSL all supported. CLI-agnostic: graders are run by the existing `bin/exec-mode-experiment.sh` harness which runs identically across claude / codex / gemini / mock CLIs (Phase 3+ invariant). (r3: artifact list reflects JSON registry + stdlib-only lint; PyYAML removed per codex R2-N1.)

### Q5 (Preamble 사용자 경험 원칙): 사용자에게 "어떻게"를 강요하지 않는가?

**PASS** — End users do not interact with this rule. Grader authors (dustcraw and devkit coder sessions) consume the rule through the existing cascade-grader-rubric review process; the rule adds two checklist items + one `metrics.json` field + one lint invocation. The dustcraw fixture-authoring contract (Phase 6 spec §4.4) already enumerates the expected grader behavior; this ADR formalizes one of those bullets (item 4: "Grader emit") into a project-wide rule.

### Optional 18-article spot checks (load-bearing articles, ecosystem scope)

| Article | PASS/FAIL | Note |
|---|:-:|---|
| 제5조 최선 | PASS | MUST chosen over weaker forms per §2.2 evidence; not a 차선책. |
| 제13조 비판적+건설적+객관적 | PASS | Rule traces back to gemini D3 critical review; constructive (registry path for grandfathering); objective (RFC 2119 + auditable mechanisms, no judgment-call enforcement). |
| 제18조 벤치마크 우선 디버깅 | PASS | Rule applies *to* the benchmark layer; the rule itself is an upstream-of-debugging discipline reinforcement. |

## §5 Trade-off Matrix

Weights anchored at "헌법 정합" = 5 (load-bearing for ecosystem-scope ADR); other weights per architect AGENTS.md §7 reviewer-matrix conventions.

| 기준 | Weight | Alt A (SHOULD) | Alt B (reviewer only) | Alt C (flag only) | Alt D (no grandfathering) | **Chosen (§2.4 + §11 registry)** |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 구현 복잡도 (lower better, 5=lowest) | 2 | 5 | 4 | 4 | 2 | **3** |
| 리스크 (lower bias risk better, 5=lowest) | 4 | 1 | 3 | 2 | 5 | **4** |
| 헌법 정합 | 5 | 2 | 3 | 3 | 3 | **5** |
| 크로스 플랫폼 호환 | 3 | 5 | 5 | 5 | 5 | **5** |
| Phase 6 일정 영향 (lower impact better) | 4 | 5 | 5 | 5 | 1 | **4** |
| 가역성 (one-way OK if benefit clear) | 2 | 4 | 4 | 4 | 2 | **3** |
| Auditability (mechanical check possible) | 3 | 1 | 3 | 4 | 5 | **5** |
| **Weighted total** | | 53 | 70 | 70 | 64 | **89** |

Calculation: weighted sum = Σ(weight × score). Chosen scores 89/100, ≥27% above the next-best alternative (Alt B/C tied at 70). The dominant factors driving the gap are 헌법 정합 (Article 1 경량 + Article 13 비판적+건설적+객관적 + Article 17 무의존 all align with three-mechanism + registry approach) and Auditability (gemini D3 explicitly required mechanical-check enforcement).

## §6 Backward Compatibility

### §6.1 Affected consumers

| Consumer | Impact | Required change |
|---|---|---|
| Existing primary graders (H1, H10, H11–H14 prospectively) | Additive: new sub-fields at `metrics.json::quality.primary_components.formatting_exempt_*` (no schema patch — additive within free-form sub-object per §6.3) | NEW graders (H11–H14) implement per §2.4.2 from the start (Phase 6 spec §4.4 item 4 already mandates this; this ADR formalizes). EXISTING graders (H1: pending-migration; H10: grandfathered) per §2.3 + §11 registry. |
| Cascade-grader-rubric review template | Two new checklist items per §2.4.1 | Template patch (devkit `docs/reviews/_template.md` or equivalent — coder task per §8.1). |
| Pre-reg tag pre-condition checklist | One new item: `bin/lint-formatting-exemption.py` exit 0 (hard pre-condition; r2 codex MAJOR 5) | Phase 6 spec §8.3 add 7th pre-condition item (orchestrator updates spec or Phase 6-conclusion-ADR amends). |
| `metrics.json` schema_version=1 | NO version bump (additive-only, unknown fields ignored per Phase 3+ invariant) | None — analyst aggregation scripts that don't read the new field continue to work unchanged. |
| Existing analyst reports (Phase 3, 4, 5) | NONE — historical reports do not need re-aggregation | No re-fire required for grandfathered fixtures. |

### §6.2 Migration path for grandfathered fixtures

Each grandfathered (or pending-migration) fixture's exemption-registry entry (§11) carries an `expiry` date and a planned migration commit. The migration is:

1. Cascade-grader-rubric review session patches the grader to add canonicalization step + emit `formatting_exempt_status: implemented`.
2. Patched grader passes review (≥1 reviewer ACCEPT per cascade-13 pattern).
3. Registry entry status flips from `grandfathered` (or `pending-migration`) to `migrated` with `migration_commit` populated by the patch commit SHA.
4. Next pre-reg tag using the patched grader gates on §2.4.3 lint passing for that fixture (no longer relies on registry).

No big-bang migration; per-fixture migration on natural patch occasions, but bounded by the registry-entry `expiry` field (r2 — gemini D1 + codex MAJOR 3: hard deadline).

### §6.2.1 Grader-SHA isolation rule (r2 — addresses codex MAJOR 6)

**Rule**: When a grader is patched to add canonicalization (status flips from `grandfathered`/`pending-migration` to `implemented`), trial scores from the **pre-patch grader SHA** and **post-patch grader SHA** MUST NOT be mixed in any aggregation, comparison, or significance test, **unless** both grader SHAs are explicitly disclosed and the comparison is documented as a between-grader-SHA contrast (e.g., a planned re-grading replication study).

**Operational requirements**:

1. **Registry tracks both SHAs**: each migrated entry carries `pre_patch_grader_sha` and `migration_commit` (which the post-patch SHA can be derived from). Lint check 3 surfaces a registry entry's SHA pair.
2. **Analyst report disclosure**: any analyst report aggregating trials across a migration boundary MUST stratify scores by grader_SHA in tables and explicitly state the SHA pair in the methodology section.
3. **Pre-reg tag annotation**: pre-registration tag annotations list the grader SHAs of all in-scope graders (per Phase 5 spec §5.1 item 9, which Phase 6 spec §8.1 item 9 inherits). When a fixture migrates between phases, the new phase's tag annotation MUST note "grader migrated from `<pre_sha>` to `<post_sha>` per ADR `2026-05-02-output-style-fixture-design-rule.md` §6.2.1".

**Why this rule**: Adding canonicalization changes grader semantics. Old trial outputs scored against the old grader produce different `quality.primary` numbers than the same outputs scored against the new grader (the canonicalizer accepts wrappers the old grader penalized). Mixing pre- and post-patch scores in one mean conflates grader change with phenomenon change. Codex MAJOR 6 evidence: prior analyst reports (Phase 3, 4, 5) are safe only if they stay frozen at their phase's grader SHA; cross-phase aggregation requires explicit grader-SHA stratification.

### §6.3 Schema additive guarantee

The new `formatting_exempt_*` fields live inside `metrics.json::quality.primary_components` (r2 — relocated from top-level per BLOCKER 1 fix). The `quality.primary_components` object is declared free-form in `metrics.v1.json:156-159` ("Free-form per-fixture grader sub-scores"), so adding new keys requires NO schema patch and NO harness patch. Any tool reading `metrics.json` that does not look up `quality.primary_components.formatting_exempt_*` continues to function identically. This is consistent with the Phase 3 schema_version=1 design contract that the free-form sub-object is the agreed extensibility surface for per-fixture grader detail (codex C4 endpoint discipline: top-level keys are the stable contract; `primary_components` is the extension point).

**Backward compatibility for historical metrics.json**: Phase 3–5 trial files (without these new fields) remain valid against `metrics.v1.json` because the schema treats `primary_components` keys as optional. Lint check 1 (§2.4.3) interprets field absence as "not_emitted" and surfaces the absence as a lint failure for **future** trials; it does NOT retroactively invalidate historical trials.

## §7 Consequences

### §7.1 긍정적 결과

1. **Eliminates the Phase 5 NB3-class dormant-bias surface for all NEW fixtures** — every Phase 6+ grader is auditable for output-style equivalence at three lifecycle gates.
2. **Closes gemini D3** from the Phase 5 final review — D3 condition explicitly satisfied (rule + 3-mechanism enforcement + adversarial test cases).
3. **Satisfies codex C3 binding-pre-reg discipline** — no post-hoc "we'll add canonicalization later" rationalization vector.
4. **Documents grandfathering debt explicitly** — the exemption registry makes the H1/H10 carry-over visible and trackable, preventing silent debt accumulation.
5. **Cascade-grader-rubric template improvement is reusable** — the two new checklist items raise the floor for ALL future grader reviews, not just output-style cases.

### §7.2 비용 / 부정적 결과

1. **Phase 6 grader authoring cost increase** — H11–H14 each pay ~1 cascade-grader-rubric review iteration extra to address the new checklist items (Phase 5 §5.4 cascade-13 precedent: max 5 iterations; expected 1 additional). Mitigated by parallel dispatch.
2. **Pre-tag pre-condition checklist gains one item** — Phase 6 spec §8.3 amendment required; orchestrator process change.
3. **Coder-session work to implement lint script** — ~80 LOC Python stdlib only (registry parsed via stdlib `json.load`; no PyYAML), 2–3 hour task per Article 1 estimate (r2: AST + smoke-run analysis raises LOC vs r1's bash+jq estimate; r3: stdlib-only path simplifies dependency surface vs r2's incorrect pyyaml-baseline claim). Tracked as separate coder task.
4. **Registry maintenance overhead** — small (1 entry per grandfathered fixture, manually updated on migration); ~5 entries expected through Phase 6.

### §7.3 알려지지 않은 리스크

1. **"Structurally-equivalent" definition edge cases** — e.g., a fixture where formatting *is* the scoring surface (markdown-rendering correctness test). The rule wording §2.1 says "edge cases require explicit exemption documentation in the grader spec" — this is the safety valve, but its application to ambiguous cases will be reviewer-judgment-dependent. Forwarded to §9 OQ2.
2. **Adversarial test case coverage criteria** — §2.4.1 reviewer checklist item 2 says "at least one positive case for each structurally-equivalent variant the grader may encounter" — the breadth of "may encounter" is reviewer-determined. May need follow-up sub-ADR if Phase 6 graders surface ambiguity.
3. **Grandfathering registry growth without migration** — if no fixture-author session prioritizes registry-debt repayment, the registry may grow over phases. Mitigated by tracking ticket per entry (§11 schema requires planned patch ETA + tracking ticket).

### §7.4 의존 컴포넌트 실패 시나리오

| Scenario | Behavior | Recovery |
|---|---|---|
| Lint script `bin/lint-formatting-exemption.py` not yet implemented at Phase 6 pre-tag time | **Pre-tag is BLOCKED** (r2 — addresses codex MAJOR 5; the §8.3 milestone is **promoted to a hard pre-tag pre-condition** — no manual-verification fallback is permitted) | Orchestrator MUST dispatch coder to complete §8.3 before pre-tag. If unavoidable schedule slip occurs, the only escape is a **fail-closed manual equivalent**: a notarized checklist file `~/projects/aigentry-devkit/state/exec-mode-experiment/<phase>/pre-tag/manual-lint-equivalent.md` enumerating each grader, each of the four §2.4.3 checks, and a reviewer signature; this file MUST be referenced in the tag annotation. The notarized fallback expires at Phase 6 pre-tag end; Phase 7 has no manual fallback option. |
| Cascade-grader-rubric reviewer overlooks the new checklist items | Grader admitted without §2.4.1 verification | Pre-tag lint (§2.4.3) catches this in the second gate; if both miss, post-hoc detection in analyst report. Defense-in-depth design absorbs single-gate failures. |
| Orchestrator crashes during Phase 6 pre-tag flow | Manual orchestrator-process steps may be partially completed | Phase 6 spec §8.3 pre-condition checklist is restartable (idempotent verification); orchestrator restart re-runs verification. NO trial fire is gated by orchestrator state mid-flight (gating happens only at tag commit). |
| Exemption registry file deleted or corrupted | Pre-tag lint cannot resolve grandfathering claims | Lint MUST fail-closed (exit non-zero) on missing registry; orchestrator restores from git history. Registry is git-tracked. |
| Grader emits `formatting_exempt_status` with invalid enum value (e.g., string `"true"`, boolean, missing field) | Lint check 1 (§2.4.3) requires enum value ∈ {`implemented`, `not_applicable`, `grandfathered`}; any other value or absence is a lint failure | Lint diagnostic identifies the malformed grader; coder fixes. Enum membership is enforceable by Python `if value not in {"implemented", "not_applicable", "grandfathered"}: fail`. (r2 — replaces r1's bool check per BLOCKER 2 fix.) |
| Registry-entry expiry date passes without migration completed | Lint check 3 (§2.4.3) requires registry entry to be non-expired; expired entries fail check | Lint emits diagnostic naming the expired fixture + its expiry date + the responsible tracking ticket; orchestrator MUST either (a) dispatch migration to clear the entry or (b) escalate to architect for a sub-ADR justifying expiry extension. **No silent extension.** (r2 — gemini D1 + codex MAJOR 3 enforcement) |

## §8 Verification Plan

### §8.1 Implementation milestones (this ADR's acceptance triggers each)

| ID | Milestone | Owner | Pre-condition for | Verification |
|---|---|---|---|---|
| §8.1 | Cascade-grader-rubric review template gains two checklist items per §2.4.1 (verbatim phrasing) | aigentry-devkit coder session (orchestrator dispatch) | Phase 6 grader reviews (H11–H14) | `grep` for the two checklist phrases in template file; manual diff review. |
| §8.2 | Grader skeleton template (for new graders) emits `formatting_exempt_status` enum + companion fields per §2.4.2 | aigentry-devkit coder session | Phase 6 grader authoring (dustcraw + devkit coder) | `grep` for the field keys in skeleton; sample `metrics.json` from H11 pilot trial includes `quality.primary_components.formatting_exempt_status` ∈ {implemented, not_applicable}. (r2 — relocated per BLOCKER 1, enum per BLOCKER 2.) |
| §8.3 | `bin/lint-formatting-exemption.py` implemented + smoke-tested on existing graders. **Hard pre-condition for Phase 6 pre-reg tag** (r2 — codex MAJOR 5: no manual-fallback degradation; only the §7.4 notarized fallback applies, and it expires at Phase 6 end) | aigentry-devkit coder session | Phase 6 pre-reg tag commit | All four §2.4.3 checks pass smoke test against H1, H10, H11–H14. Negative test: removing H10's registry entry causes check 3 to fail; removing H11's `implemented` status causes check 4 to fail. |
| §8.4 | Exemption registry initialized at `~/projects/aigentry-devkit/state/fixtures/_exemption-registry.json` (machine-readable JSON per §11 r3 schema) with H1 (pending-migration) + H10 (grandfathered, expiry 2026-08-01) entries (and H5 NB3 case as the first historical entry) | aigentry-devkit coder session | Phase 6 pre-tag lint (which depends on registry presence) | Registry file exists, parseable by Python stdlib `json.load`, contains at least 2 active entries (H1, H10) plus H5 historical record; all required fields per §11 r3 schema populated. (r3 — JSON migration per codex R2-N1.) |
| §8.5 | Phase 6 cross-LLM grader review for H11–H14 explicitly cites this ADR's reviewer checklist items | aigentry-devkit cascade-grader-rubric review sessions | Phase 6 pre-reg tag commit | Each H11–H14 grader review report (`docs/reviews/2026-05-XX-phase6-grader-rubric-review-{cli}-{round}.md`) explicitly references §2.4.1 by ADR ID and contains both checklist items marked. |
| §8.6 | H1 NB3 patch session ALSO satisfies §2.4 (status flips to `implemented`) — registry entry transitions from `pending-migration` to `migrated` with `migration_commit` populated (r2 — codex MAJOR 4 + §2.3 row 2) | aigentry-devkit cascade-grader-rubric review session (orchestrator dispatch per §10.6) | Phase 6 pre-reg tag commit | Registry H1 entry status = `migrated`; lint check 2 passes against H1 grader (canonicalizer named, variants listed, tests exist). |

### §8.2 Success metrics (mechanical, post-Phase-6)

| Metric | Measurement | Success threshold | Failure trigger (rollback indicator) |
|---|---|---|---|
| **M1**: H11–H14 grader compliance rate at pre-reg tag | `bin/lint-formatting-exemption.py` checks 1+2 result on each grader | 4/4 graders emit `formatting_exempt_status` ∈ {`implemented`, `not_applicable`} AND companion-field consistency holds AND pass §2.4.1 reviewer checklist items 1+2 | Any single failure triggers cascade-grader-rubric re-review; rollback = grader excluded from Phase 6 grid until compliant. |
| **M2**: Per-trial status emission rate | `jq '.quality.primary_components.formatting_exempt_status'` on Phase 6 `metrics.json` files | 100% of Phase 6 trial `metrics.json` contain the field with valid enum value | <100% triggers harness-bug investigation (the field is grader-emitted, harness-passthrough via `quality.primary_components`; missing field = grader bug). |
| **M3**: Pre-tag lint zero-exit | `bin/lint-formatting-exemption.py; echo $?` at Phase 6 pre-tag time | Exit 0 (all four checks pass on all in-scope graders) | Non-zero exit blocks tag commit; orchestrator escalates to architect for sub-ADR amendment. |
| **M4**: Reviewer-checklist citation rate | `grep` ADR ID in Phase 6 grader review reports | 100% of H11–H14 review reports cite this ADR by ID | <100% triggers reviewer-instruction addendum (orchestrator dispatch correction). |
| **M5**: Registry expiry-clearance rate (gemini D1 + codex MAJOR 3) | New entries added vs migrated entries cleared per phase | By 2026-08-01 (Phase 7 deadline), registry has 0 entries with status ∈ {`grandfathered`, `pending-migration`}. After 2026-08-01, registry contains only `migrated` (historical) and `retired` rows. | Any active (`grandfathered` or `pending-migration`) entry past expiry triggers debt-payoff sub-ADR or notarized expiry-extension justification. |
| **M6**: Phase 6 NB3-class incident rate | Analyst report scan for "output-style asymmetry" or equivalent flagged findings on Phase 6 dataset | 0 instances on H11–H14 (flagged-and-mitigated incidents on grandfathered fixtures excluded) | ≥1 instance triggers urgent grader patch + sub-ADR review of rule wording adequacy. |
| **M7** (r2 — codex MAJOR 6): Grader-SHA stratification compliance | Phase 6 final analyst report inspection | 100% of cross-grader-SHA aggregations in the report carry explicit `pre_patch_grader_sha` + `post_patch_grader_sha` disclosure | Missing disclosure triggers analyst-report revision before publication. |

### §8.3 Verification timeline

- M1, M3, M4: at Phase 6 pre-reg tag commit (~late 2026-05).
- M2: continuously from Phase 6 trial fire (each `metrics.json` file).
- M5: at each future phase pre-tag commit (Phase 7+).
- M6: at Phase 6 final analyst report review (~mid 2026-06 estimate).

## §9 Open Questions

### §9.1 OQ1 — Migration ETA for grandfathered fixtures (H1, H10)

**Question**: When do H1 and H10 graders get patched to satisfy §2.4 (eliminating their registry entries)?

**Spec default (r2 update)**: H1 is now `pending-migration` with hard expiry 2026-05-30 (Phase 6 pre-reg tag). H10 is `grandfathered` with hard expiry 2026-08-01 (Phase 7 deadline, gemini D1). Both deadlines are tracked in §11 registry `expiry` field; lint check 3 + M5 metric + §7.4 expiry-failure row enforce. The "indefinite" gap r1 left for H10 is closed in r2.

**Forwarded to**: §8.6 milestone (H1 NB3 patch dual-obligation tracker); orchestrator amendment to Phase 6 cascade-grader-rubric dispatch instructions for H1 to ALSO satisfy §2.4.

### §9.2 OQ2 — "Structurally-equivalent" definition edge cases

**Question**: Where is the boundary between "structurally-equivalent variants the grader MUST normalize" and "formatting differences that ARE the scoring surface"?

**Examples requiring judgment**:

- A fixture testing "agent produces correctly-formatted markdown table" — formatting IS the scoring surface; canonicalization would defeat the test. The §2.1 wording's "edge cases require explicit exemption documentation in the grader spec" accommodates this, but the boundary is reviewer-judged.
- A fixture testing "agent emits valid JSON" — is "JSON inside markdown fence" structurally-equivalent to "raw JSON at top of response"? Likely yes (both are valid JSON if extracted), but a strict-format fixture may require the raw-only form.

**Spec default (r2 update)**: §2.1 scope-clarification table (added in r2) now enumerates the in-scope vs out-of-scope boundary for the most common cases. Beyond the table, the grader spec docstring (per §2.4.2 `not_applicable` case requirements) remains the authoritative document of what counts as structurally-equivalent for that specific grader. Reviewers MUST cite the docstring's `formatting_exempt_justification` section + the §2.1 scope-clarification table for their judgment.

**Forwarded to**: Phase 6 first reviewer iteration on H11–H14; if ambiguity surfaces beyond the §2.1 table, follow-up sub-ADR may refine the definition with concrete decision tree (gemini MINOR 2 + D3 partially mitigated by §2.1 table — full decision tree deferred to follow-up if needed).

### §9.3 OQ3 — Registry path location stability

**Question**: Is `~/projects/aigentry-devkit/state/fixtures/_exemption-registry.json` the correct long-term home, or should it move to `aigentry-orchestrator/docs/registry/` or similar?

**Spec default**: Place at devkit `state/fixtures/_exemption-registry.json` because (a) it is operationally read by the devkit lint script, (b) it tracks devkit-resident fixture artifacts. Underscore prefix reserves it as a meta-file (Phase 5 convention for non-fixture state files). r3: file extension `.json` reflects Article 17 무의존 stdlib-only resolution (codex R2-N1; r2's `.yml` required PyYAML, which is NOT in `requirements-exec-mode.txt`).

**Relocation gate (r2 — codex MINOR 4)**: Path relocation is **NOT coder-discretionary**. If the path is unsuitable for any reason, the coder session MUST report the issue to the orchestrator and request either (a) an architect ADR-revision (this ADR's r3) or (b) explicit orchestrator approval recorded in the relocation commit message. r1 left this as coder discretion; r2 closes that loophole.

**Forwarded to**: registry first-write coder task (§8.4) — if path is unsuitable, escalate; do not silently relocate.

### §9.4 OQ4 — Lint script implementation language (resolved in r2)

**r2 resolution**: Python stdlib is **the spec choice**, not coder discretion. r1 left this open with bash-preference; r2 closes it because §2.4.3 lint check 2 requires AST analysis of grader source files (Python `ast` module) and check 1 requires running smoke `score-fixture` invocations and parsing JSON returns. Bash+jq cannot perform AST walks and would either degrade lint check 2 to regex (the codex MAJOR 1 failure mode) or shell-out to Python anyway. Direct Python implementation is the simpler best path.

**Script**: `bin/lint-formatting-exemption.py` (Python stdlib only; registry parsed via `json.load`). (r3 — codex R2-N1 fix: pyyaml dependency removed, registry migrated to JSON.)

**Status**: Resolved; coder task §8.3 implements per this resolution, not per coder language preference.

### §9.5 OQ5 — Shared canonicalization library for dustcraw (r2 — gemini D2 forwarded)

**Question**: Should devkit ship a shared library `~/projects/aigentry-devkit/lib/grader_canonicalize.py` providing common canonicalizations (strip-markdown-fence, normalize-backtick-identifier, JSON-load-from-prose, etc.) so dustcraw fixture authors avoid per-grader boilerplate?

**Disposition (gemini D2 condition forwarded, not waived)**: This is an ergonomics improvement worth pursuing but **not a Phase 6 acceptance pre-condition**. The rule (§2.1) is enforceable per-grader without a shared library. Mandating the library would couple ADR acceptance to a separate engineering deliverable (Article 1 경량 violation). Forwarded to coder backlog.

**Forwarded to**: §10.6 row 7 (new) — coder dispatch for `lib/grader_canonicalize.py` skeleton + 3 initial helpers (strip_markdown_json_fence, normalize_backtick_identifier, normalize_tool_call_wrapper). Implementation can ship in parallel with or after Phase 6.

## §10 Related

### §10.1 Supersedes

- **Parent ADR §11 item 3 paraphrase** ("graders for structurally-identical data ... MUST implement formatting-exemption logic") — superseded as a stub by the verbatim Phase 6 spec §2.3.1 wording in §2.1 of this ADR. Parent ADR §11 stub remains as historical pre-registration record.

### §10.2 Related ADRs / Specs

- `docs/adr/2026-05-01-rule-4-a-step-4-final-lock.md` — parent ADR (§11 item 3 stub for this rule).
- `docs/superpowers/specs/2026-05-02-phase6-design.md` — Accepted Phase 6 spec (§2.3, §3.3, §6.3, §10.3 all reference this ADR by name; §4.4 dustcraw fixture-authoring contract item 4 implements §2.4.2).

### §10.3 Related tasks

- task-queue #329 E27 (Phase 6 Q3).

### §10.4 Analyst diagnostics

- `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-final-analysis.md` §7 (NB3 root cause + H5 case study).
- `~/projects/aigentry-devkit/docs/reports/2026-05-01-phase5-gemini-review.md` §6 + §10 (D3 verbatim).

### §10.5 Benchmarks

- N/A — this ADR is rule-form (no fire-time measurement). M1–M6 success metrics (§8.2) are mechanical lints, not benchmarks.

### §10.6 Forwarded to coder/builder sessions

The following implementation work is dispatched separately by the orchestrator post-acceptance (NOT done in this architect session per §5.1 INVARIANT no-code-writing):

1. Coder dispatch: implement `bin/lint-formatting-exemption.py` per §8.1 milestone-row 3 (devkit repo). Python stdlib only (registry parsed via `json.load`; no PyYAML); 4 checks per §2.4.3; AST + smoke-run + JSON inspection.
2. Coder dispatch: patch cascade-grader-rubric review template per §8.1 milestone-row 1 (devkit repo `docs/reviews/`).
3. Coder dispatch: patch grader skeleton per §8.1 milestone-row 2 (devkit repo `tests/exec-mode/graders/`); skeleton emits `quality.primary_components.formatting_exempt_status` enum + companion fields per §2.4.2 r2 contract.
4. Coder dispatch: initialize exemption registry per §8.1 milestone-row 4 (devkit repo `state/fixtures/_exemption-registry.json`); machine-readable JSON per §11 r3 schema; seed with H1 (pending-migration, expiry 2026-05-30) + H10 (grandfathered, expiry 2026-08-01) + H5 (retired, historical NB3 reference).
5. Orchestrator dispatch: cascade-grader-rubric session amendment for H1 NB3 patch to ALSO satisfy §2.4 (per §8.6 + §9.1 OQ1).
6. Orchestrator dispatch: Phase 6 spec §8.3 amendment to add 7th pre-tag pre-condition (lint script exit 0).
7. Coder dispatch (r2 — gemini D2 forwarded, NOT a Phase 6 acceptance pre-condition): scaffold `~/projects/aigentry-devkit/lib/grader_canonicalize.py` with 3 initial helpers — `strip_markdown_json_fence(text) -> str | None`, `normalize_backtick_identifier(text) -> str`, `normalize_tool_call_wrapper(text) -> str`. Each helper has a docstring + adversarial unit test under `tests/lib/test_grader_canonicalize.py`. Helpers MAY be used by H11–H14 graders for canonicalization; usage is recommended but not mandated by the rule.

---

## §11 Initial Exemption Registry Schema (r3 — machine-readable JSON, Article 17 무의존 stdlib-only; codex MAJOR 3 + gemini D1 + codex R2-N1)

**r3 redesign rationale (codex R2-N1)**: r2 used YAML, which forced a `pyyaml` dependency in the lint script (§2.4.3, §9.4). Verification against `~/projects/aigentry-devkit/requirements-exec-mode.txt` (entries: `rapidfuzz`, `pandas`, `scipy`, `matplotlib`, `pytest`, `jsonschema`, `tiktoken`) and `.venv-exec-mode/bin/python -c 'import yaml'` (fails with `ModuleNotFoundError: No module named 'yaml'`) confirms PyYAML is NOT in the exec-mode baseline. r2's claim that "pyyaml is already in devkit requirements.txt per Phase 5 baseline" was factually wrong.

r3 migrates the registry to **JSON** (Python stdlib `json` module). This:
1. Honors Article 17 무의존 (zero new external dependencies).
2. Preserves codex MAJOR 3 (machine-readable for lint check 3 — JSON parses identically robustly).
3. Preserves gemini D1 (expiry fields unchanged).
4. Preserves the field schema and field count (functionally equivalent to the r2 YAML form — fields preserved, format changed).

**r2 → r3 format-only diff**: schema fields unchanged; comment-style annotations removed (JSON does not support inline comments); semantics documented in the required-fields table below this code block.

**r2 historical context retained**: r1 used a markdown table for the registry, which codex MAJOR 3 correctly flagged as fragile for a linter to parse. r2 promoted to YAML with explicit fields; r3 finalizes the format choice as JSON.

The registry file `~/projects/aigentry-devkit/state/fixtures/_exemption-registry.json` (created by coder per §8.4) MUST follow this schema:

```json
{
  "schema_version": "1",
  "rule_adr": "2026-05-02-output-style-fixture-design-rule",
  "comment": "Fixture Exemption Registry. Per ADR 2026-05-02-output-style-fixture-design-rule.md §2.3 + §11. Lint consumer: bin/lint-formatting-exemption.py (§2.4.3 check 3). JSON does not support inline comments; field semantics in ADR §11 required-fields table.",
  "entries": [
    {
      "fixture_id": "H1",
      "fixture_slug": "long-form-code-review",
      "status": "pending-migration",
      "grader_path": "tests/exec-mode/graders/score_h1_long_form_code_review.py",
      "pre_patch_grader_sha": null,
      "rationale": "Pre-Phase 6 fixture reused per Phase 6 spec §4.1 line 266 + §10.4 line 358. NB3 patch in-flight per Phase 6 spec line 271 — required BEFORE Phase 6 pre-reg tag. The NB3 patch session ALSO satisfies §2.4 (status flips to `implemented` in same iteration; pre_patch_grader_sha + migration_commit populated; status flips to `migrated`).",
      "expiry": "2026-05-30",
      "tracking_ticket": "task-#329 E27 (Phase 6 Q3 follow-up + Phase 6 §10.4 NB3 patch)",
      "approving_session": "aigentry-orchestrator-claude (per Phase 6 spec acceptance 2026-05-02)",
      "migration_commit": null,
      "lint_allow_status_grandfathered": false
    },
    {
      "fixture_id": "H10",
      "fixture_slug": "strict-instruction-following",
      "status": "grandfathered",
      "grader_path": "tests/exec-mode/graders/score_h10_strict_instruction_following.py",
      "pre_patch_grader_sha": null,
      "rationale": "Pre-Phase 6 fixture reused per Phase 6 spec §4.1; no in-flight patch in Phase 6. Migration deferred to next natural patch occasion or Phase 7 deadline, whichever first.",
      "expiry": "2026-08-01",
      "tracking_ticket": "task-#329 E27 (Phase 6 Q3 follow-up)",
      "approving_session": "aigentry-orchestrator-claude (per Phase 6 spec acceptance 2026-05-02)",
      "migration_commit": null,
      "lint_allow_status_grandfathered": true
    },
    {
      "fixture_id": "H5",
      "fixture_slug": "agentic-tool-use",
      "status": "retired",
      "grader_path": "tests/exec-mode/graders/score_h5_agentic_tool_use.py",
      "pre_patch_grader_sha": null,
      "rationale": "Phase 5 NB3 case study (analyst §7). Fixture replaced in Phase 6 per spec §4.2 line 281. If un-retired in any future phase, treat as NEW per ADR §2.3 row 1 (status MUST become `implemented` or `not_applicable`; cannot fallback to `grandfathered`).",
      "expiry": null,
      "tracking_ticket": "analyst-report `2026-05-01-phase5-final-analysis.md` §7",
      "approving_session": "aigentry-orchestrator-claude (per Phase 5 final ADR + Phase 6 spec)",
      "migration_commit": null,
      "lint_allow_status_grandfathered": false
    }
  ]
}
```

**Per-entry field annotations (moved from YAML inline comments since JSON has none)**:

- `status` enum domain: `implemented` | `not_applicable` | `grandfathered` | `pending-migration` | `migrated` | `retired`
- `grader_path`: relative to devkit repo root.
- `pre_patch_grader_sha`: populated by §8.4 coder at registry-write time (current SHA snapshot for grader-SHA isolation per §6.2.1); paired with `migration_commit` at migration land.
- `expiry` for `H1` (`2026-05-30`): Phase 6 pre-reg tag deadline. Lint fail-closed after this date if not migrated.
- `expiry` for `H10` (`2026-08-01`): gemini D1 — Phase 7 deadline aligning with Pacc sunset window per Phase 6 spec §4.2.
- `migration_commit`: populated post-patch.
- `lint_allow_status_grandfathered` for `H1`: `false` — H1 is `pending-migration`, not `grandfathered`; lint check 4 enforces NEW-fixture hard-block separately.
- `lint_allow_status_grandfathered` for `H10`: `true` — H10 is the only fixture for which lint check 3 may accept `formatting_exempt_status: "grandfathered"` until `expiry`.
- `lint_allow_status_grandfathered` for `H5`: `false` — `retired` entries are historical record only; lint MUST NOT consult them for active gating.

**Required fields per entry** (codex MAJOR 3):

| Field | Type | Purpose |
|---|---|---|
| `fixture_id` | string | matches `metrics.json::fixture_id` pattern; primary lookup key |
| `fixture_slug` | string | human-readable slug for cross-reference |
| `status` | enum | `implemented` (post-migration), `not_applicable`, `grandfathered`, `pending-migration`, `migrated`, `retired` |
| `grader_path` | string (relative to devkit repo) | enables lint to locate grader source for AST checks |
| `pre_patch_grader_sha` | string \| null | grader SHA at registry-write time; populated for active entries; required for §6.2.1 grader-SHA isolation |
| `rationale` | string | why this entry exists; references binding source (Phase 6 spec line, parent ADR, etc.) |
| `expiry` | ISO date string \| null | hard deadline beyond which lint check 3 fails closed; null only for `retired` and `migrated` (post-migration) entries |
| `tracking_ticket` | string | task-queue ID or analyst-report reference for follow-up |
| `approving_session` | string | session ID that authorized the registry entry (audit trail) |
| `migration_commit` | string \| null | populated when `status: migrated` — git commit SHA of the migration patch |
| `lint_allow_status_grandfathered` | bool | explicit lint-allowance bit per entry; defaults `false`; only `H10` (and any future grandfathered-deferred fixture) sets `true` |

**Initial seed entries (r2)**:

- **H1** — `pending-migration` with `expiry: 2026-05-30` (Phase 6 pre-reg tag deadline). Codex MAJOR 4 resolution: H1 is NOT a durable grandfathered example; it MUST migrate at NB3 patch (already required by Phase 6 spec line 271). The §8.6 milestone tracks this.
- **H10** — `grandfathered` with `expiry: 2026-08-01` (gemini D1 — Phase 7 deadline aligning with Pacc sunset window per Phase 6 spec §4.2). After expiry without migration, lint fails closed per §7.4 + M5.
- **H5** — `retired`, historical NB3 case study reference. Retained for un-retire-treatment continuity (per §2.3 row 5).

**Lint smoke-example update (r2 — codex MAJOR 4)**: §8.3 lint smoke negative test MUST use H10 as the durable `grandfathered` exemplar, NOT H1. H1 is a pending-migration example that flips to `implemented` at the §8.6 milestone, so it is unsuitable as a permanent lint smoke fixture for the `grandfathered` path.

---

## §12 r2 Dispositions Table — review findings → ADR sections (auditable trail)

This section enumerates every finding from the r1 review round (codex aed61e8 + gemini b1bcf74) and its disposition in r2. Codex BLOCKERS + 5 conditions get their own §13 disposition; this §12 covers the 6 codex MAJORS + 4 codex MINORS + 2 gemini MINORS.

### §12.1 Codex MAJORS disposition

| ID | Finding (codex review §8 verbatim summary) | Disposition | r2 Location |
|---|---|---|---|
| MAJOR 1 | Regex-only lint is too weak (passes comments, dead branches, nested fields, no-op canonicalizers) | **Integrated** — lint redesigned to AST + smoke-run + emitted-JSON inspection (4 checks, false-positive defense table) | §2.4.3 (full rewrite) |
| MAJOR 2 | `true` flag is not evidence of canonicalization (require canonicalizer name + adversarial tests) | **Integrated** — status enum + companion fields (`canonicalizer`, `variants`, `tests`) required; lint check 2 verifies AST presence | §2.4.2 (status enum) + §2.4.3 (check 2) |
| MAJOR 3 | Registry schema not machine-robust or long-term complete (markdown table fragile; missing fields) | **Integrated** — registry promoted to JSON (r3 — was YAML in r2; format changed to honor Article 17 무의존 stdlib-only per codex R2-N1; 11 required fields per entry: grader_path, SHA, expiry, reviewer, lint-allowance, etc.) | §11 (full rewrite, r2 YAML → r3 JSON) |
| MAJOR 4 | H1 grandfathering conflicts with required Phase 6 NB3 patch path | **Integrated** — H1 reclassified to `pending-migration` with `expiry: 2026-05-30` (Phase 6 pre-reg deadline); §8.6 milestone tracks NB3-patch-also-satisfies-§2.4 obligation; lint smoke example switched from H1 to H10 | §2.3 (row 2 added) + §8.6 + §11 (H1 entry) |
| MAJOR 5 | Missing-lint fallback weakens "all three required" — manual-verification escape hatch undermines lint as hard pre-condition | **Integrated** — §8.3 lint promoted to **hard pre-tag pre-condition** (no manual fallback by default). The only escape is a notarized fail-closed manual equivalent expiring at Phase 6 end. Phase 7+ has no manual fallback option. | §7.4 (row 1 rewrite) + §8.3 (hard pre-condition) |
| MAJOR 6 | Migration plan lacks grader-SHA and regrade isolation rules (mixing pre/post-patch scores conflates grader change with phenomenon change) | **Integrated** — new §6.2.1 grader-SHA isolation rule; registry tracks `pre_patch_grader_sha` + `migration_commit`; M7 metric tracks analyst-report compliance | §6.2.1 (new) + §11 (registry fields) + §8.2 M7 (new) |

### §12.2 Codex MINORS disposition

| ID | Finding | Disposition | r2 Location |
|---|---|---|---|
| MINOR 1 | "Verbatim-rule quoting" language overbroad (limit to binding downstream artifacts) | **Integrated** — §2.1 rewrite scopes "verbatim" to binding downstream artifacts; non-binding prose MAY paraphrase with citation | §2.1 (rewrite + scope clarification) |
| MINOR 2 | "CI" terminology inconsistent (no hosted CI runner) | **Integrated** — §2.4.3 explicitly defines "orchestrator-invoked pre-tag lint"; r2 removes "CI" usages | §2.4.3 (terminology note) |
| MINOR 3 | "Zero-dependency" phrasing should account for existing jq baseline | **Integrated** — §4 Q3 phrasing changed to stdlib-only path; r3 (codex R2-N1) further tightens by removing the incorrect pyyaml-baseline claim and migrating registry to JSON for true zero-dependency. | §4 Q3 + §2.4.3 (deps line) |
| MINOR 4 | Registry-path relocation should not be coder-discretionary | **Integrated** — §9.3 rewrite forbids silent coder relocation; relocation requires architect ADR-revision OR explicit orchestrator approval recorded in commit | §9.3 (relocation gate) |

### §12.3 Gemini MINORS disposition

| ID | Finding (gemini review §9 verbatim) | Disposition | r2 Location |
|---|---|---|---|
| MINOR 1 (gemini) | Lack of strict timeline/deadline for grandfathering registry | **Integrated** — every active registry entry now has `expiry` field (H1: 2026-05-30, H10: 2026-08-01); M5 metric tracks expiry-clearance rate; lint check 3 fails closed on expired entries | §11 (`expiry` field) + §2.3 (row 3 deadline) + §8.2 M5 + §7.4 (expiry row) |
| MINOR 2 (gemini) | Potential ambiguity around whether deep semantic equivalence (code logic) falls under "structural equivalence" | **Integrated** — §2.1 scope-clarification table (in-scope vs out-of-scope); deep semantic equivalence explicitly out-of-scope; future ADR may extend if Phase 6+ analyst surfaces such bias | §2.1 (scope clarification table) |

## §13 Conditions Disposition (codex C1-C5 + gemini D1-D3)

Per task hard-rule: each condition either (a) integrated verbatim into a relevant ADR section OR (b) explicitly waived with rationale. **r2 outcome: 8/8 conditions integrated; 0 waived.**

### §13.1 Codex 5 conditions (codex review §9)

| ID | Codex condition (verbatim) | Disposition | Integration location |
|---|---|---|---|
| C1 | "Fix the metrics contract: explicitly patch schema + harness for the top-level field, OR revise the ADR to store the flag under `quality.primary_components`." | **Integrated (option B chosen)** — ADR §2.4.2 redesigned to store status field at `quality.primary_components.formatting_exempt_status`; no schema/harness patch required; backward-compat preserved | §2.4.2 + §6.3 |
| C2 | "Replace the boolean-only exemption model with a status model that supports `implemented`, `not_applicable`, and `grandfathered`." | **Integrated verbatim** — three-state enum implemented exactly as named | §2.4.2 status semantics table |
| C3 | "Strengthen pre-tag lint from regex-only source scan to actual emitted JSON validation plus AST/smoke/unit-test evidence." | **Integrated** — §2.4.3 redesign: 4 checks, smoke-run + AST + JSON inspection; §2.4.3 false-positive defense table enumerates each codex-named bypass and its mitigation | §2.4.3 (full rewrite) |
| C4 | "Rewrite the registry schema as machine-readable data with grader path, SHA, expiry, reviewer, and migration commit fields; give H10 a concrete deadline." | **Integrated** — §11 JSON schema (r3 — was YAML in r2; r3 format-change per codex R2-N1) with all 11 fields including `grader_path`, `pre_patch_grader_sha`, `expiry`, `approving_session`, `migration_commit`; H10 expiry = 2026-08-01 | §11 (full rewrite) |
| C5 | "Resolve H1: classify it as pending migration by Phase 6 pre-reg because its NB3 patch is already required, and update the lint smoke example accordingly." | **Integrated** — H1 status = `pending-migration`, expiry = 2026-05-30 (Phase 6 pre-reg deadline); §8.6 milestone tracks NB3-patch dual obligation; §11 explicit lint smoke note swaps H1 → H10 for `grandfathered` exemplar | §2.3 row 2 + §8.6 + §11 (H1 entry + lint smoke note) |

### §13.2 Gemini 3 conditions (gemini review §10)

| ID | Gemini condition (verbatim) | Disposition | Integration location |
|---|---|---|---|
| D1 | "Establish a hard deadline (e.g., Phase 7) for clearing the exemption registry of grandfathered fixtures like H1 and H10 to prevent indefinite technical debt." | **Integrated** — H1 expiry = 2026-05-30 (Phase 6 pre-reg, codex MAJOR 4 alignment); H10 expiry = 2026-08-01 (Phase 7 deadline aligning with Pacc sunset window per Phase 6 spec §4.2). Lint check 3 + M5 metric + §7.4 expiry-failure row enforce. **Rationale for chosen dates**: H1 is bounded by an existing technical event (Phase 6 NB3 patch pre-reg), so its deadline is mechanical. H10 is bounded by the next ecosystem-meaningful date (Pacc retirement, ~2026-08-01) — earlier deadlines would force rushed migration without an aligned schedule slot; later deadlines would risk gemini's "indefinite technical debt" concern. | §11 (entries) + §2.3 row 3 + §8.2 M5 + §7.4 |
| D2 | "Provide a shared library or utility function in `devkit` for common canonicalizations (e.g., stripping markdown JSON fences) to reduce boilerplate for dustcraw fixture authors." | **Integrated as future-work in §9.5** — explicitly NOT a Phase 6 blocker (the rule applies regardless of whether a shared library exists); shared utility is a developer-ergonomics improvement that can ship independently. **Rationale for forwarding rather than mandating**: Article 1 경량 — the rule itself does not require a shared library to be enforceable; mandating the library would couple rule acceptance to a separate engineering deliverable, increasing scope without raising rigor. | §9.5 (new OQ5) + §10.6 row 7 (forwarded to coder) |
| D3 | "Clarify the boundary of 'structural equivalence' in the grader spec docstring requirements so reviewers can distinguish between formatting differences and semantic logic differences." | **Integrated** — §2.1 scope-clarification table explicitly enumerates in-scope vs out-of-scope; §2.4.2 `not_applicable` status carries `formatting_exempt_justification` docstring requirement; §2.4.1 reviewer checklist item 1 requires citation of canonicalization function (which implicitly forces docstring discussion). The boundary is operationalized through three checkpoints (grader docstring + reviewer checklist + status enum). | §2.1 (scope table) + §2.4.2 (justification req) + §2.4.1 (checklist item 1) |

## §14 r2 follow-up — re-review scope recommendation (orchestrator decision)

Per task instruction: "delegate to orchestrator the question — should we re-run codex + gemini cross-LLM review on r2 (full procedural cycle), or is spec-document-reviewer PASS sufficient given the r2 changes were targeted blocker fixes (not redesign)?"

### §14.1 r2 change scope analysis

| ADR section | r1 → r2 change type | Rationale |
|---|---|---|
| §1.2.1 | New (tier-classification rationale) | Records resolution of codex T2-needs-3rd vs gemini T2-pass |
| §2.1 | Scope additions (verbatim-quoting clarification + structural-vs-semantic boundary) | Addresses codex MINOR 1 + gemini MINOR 2 — clarification, not rule change |
| §2.3 | Row split (H1 reclassified to pending-migration; H10 expiry added) | Addresses codex MAJOR 4 + gemini D1 — operational refinement |
| §2.4.1 | Unchanged | — |
| §2.4.2 | **Significant redesign** — boolean → status enum + relocated to `quality.primary_components` | Addresses codex BLOCKER 1 + BLOCKER 2 — contract change |
| §2.4.3 | **Significant redesign** — regex → AST + smoke + JSON inspection (4 checks) | Addresses codex MAJOR 1 + C3 — contract change |
| §3.x | Unchanged | (Alternatives still hold) |
| §4 Q3 | Phrasing update (jq baseline) | codex MINOR 3 |
| §5 | Unchanged | (Trade-off matrix still holds; weighted scores unchanged) |
| §6.2.1 | New (grader-SHA isolation) | Addresses codex MAJOR 6 |
| §6.3 | Updated (relocation context) | BLOCKER 1 follow-through |
| §7.4 | Row updates (lint hard pre-condition + expiry behavior) | codex MAJOR 5 + gemini D1 |
| §8.1 | Updates (Python-default lint, registry format, §8.6 added; r3 — registry path `.yml` → `.json`) | Multiple |
| §8.2 | M7 added | codex MAJOR 6 |
| §9.3, §9.4 | Updates (relocation gate, language resolution) | codex MINOR 4, OQ4 resolution |
| §11 | **Significant redesign** — markdown → YAML (r2) → JSON (r3) schema + 11 fields + expiry | codex MAJOR 3 + C4 + gemini D1; r3 format change per codex R2-N1 (Article 17 무의존 stdlib-only) |
| §12, §13, §14 | New (dispositions trail) | r2 procedural transparency |

### §14.2 Recommendation

**Recommendation: light-cycle (spec-document-reviewer subagent PASS) sufficient, with conditional escalation trigger.**

**Reasoning**:

1. **The binding rule (§2.1) is unchanged in r2.** All r2 changes are enforcement-mechanism details, not rule redefinition. Codex itself wrote (review §10): "The rule itself should survive. The enforcement mechanics need revision before final signoff." r2 revises exactly what codex named.
2. **r2 explicitly addresses every codex BLOCKER + condition + major + minor with citation trail (§12-§13).** A second cross-LLM round risks reviewer-fatigue divergence on items already integrated; the marginal value-add is bounded.
3. **Contract changes (§2.4.2 BLOCKER 1, §2.4.3 MAJOR 1, §11 MAJOR 3) are mechanical and verifiable.** A spec-document-reviewer subagent (claude) can verify mechanical consistency: schema relocation in §2.4.2 vs metrics.v1.json:156-159 line citation; AST/smoke check enumeration; JSON schema field completeness vs §11 required-fields table (r3 — was YAML in r2).

**Conditional escalation trigger** (orchestrator should escalate to full re-review IF):

- Spec-document-reviewer surfaces ANY item it cannot verify against the codex/gemini source reports (§13 dispositions). This indicates an integration gap requiring the original reviewer's confirmation.
- Spec-document-reviewer flags any new BLOCKER (i.e., a defect r2 introduced that r1 did not have).
- User signoff request surfaces any edge case the §13 disposition table did not cover.

If none of those conditions trigger, the light cycle (subagent PASS → user signoff) is procedurally appropriate per §1.2.1 (subagent is supplemental within tier compliance) and per task spec hard-rule "procedural integrity supersedes speed" — the procedural integrity is preserved by the §12-§13 auditable disposition trail, not by reviewer-count alone.

**Final authority**: orchestrator decides per the task spec; this section is a recommendation, not a binding choice.

---

## §15 r3 Dispositions Table — codex r2 review's 2 new issues + light-cycle audit trail

**Round inputs**:
- Codex r2 review: `~/projects/aigentry-devkit/docs/reports/2026-05-02-q3-adr-r2-codex-review.md` @ `b06584b` — verdict `ACCEPT_WITH_CONDITIONS` with **2 new issues** (R2-N1, R2-N2) and 1 residual prior-minor cleanup (R2-RESIDUAL-1, NOT counted as new per codex §5).
- Gemini r2 review: `~/projects/aigentry-devkit/docs/reports/2026-05-02-q3-adr-r2-gemini-review.md` — verdict `ACCEPT`, 0 new issues. No r3 changes required from gemini.

**r3 scope**: targeted fix for the 2 new codex issues only. No redesign. The binding rule (§2.1) is unchanged. Field schema in §11 is preserved (functionally equivalent JSON form).

### §15.1 Codex r2 new-issues disposition

| ID | Codex r2 finding (verbatim summary) | r3 Disposition | r3 Location |
|---|---|---|---|
| R2-N1 | "YAML registry depends on PyYAML that is not in the exec-mode baseline" — `requirements-exec-mode.txt` lacks `pyyaml`; `.venv-exec-mode/bin/python -c 'import yaml'` fails; r2's "pyyaml is already in devkit `requirements.txt` per Phase 5 baseline" claim was false. **Condition R2-COND-1**: switch registry to JSON (best-first per Article 17 무의존), or add PyYAML as new dependency with explicit Article 17 analysis. | **Integrated (best-first option chosen)** — registry migrated to JSON; lint script uses Python stdlib `json.load`; PyYAML eliminated from all ADR sections. Article 17 무의존 strengthened (zero new external dependencies). Artifact rename: `_exemption-registry.yml` → `_exemption-registry.json`. | §11 (full JSON rewrite) + §2.4.3 deps line + §4 Q3 + §4 Q4 + §7.2 row 3 + §8.1 §8.4 row + §9.3 + §9.4 + §10.6 rows 1+4 + §12.1 MAJOR 3 row + §12.2 MINOR 3 row + §14.1 §11 row + §14.2 reasoning |
| R2-N2 | "`grandfathered` companion-field wording is internally contradictory" — §2.4.2 status row said "**field value** MUST equal an active registry entry's `fixture_id` slug" but `formatting_exempt_status` must equal the literal `"grandfathered"`; cannot also equal a slug. Implementers could encode the fixture ID in the wrong field. **Condition R2-COND-2**: rewrite the row to say lint cross-checks the trial's top-level `fixture_id` (or `quality.primary_components.fixture` if chosen) against the registry; do not overload `formatting_exempt_status` with a fixture slug. | **Integrated verbatim per condition wording** — §2.4.2 `grandfathered` row rewritten to clarify (a) the field value is literally `"grandfathered"`; (b) lint check 3 reads the trial's existing top-level `fixture_id` (or `quality.primary_components.fixture` if that is the chosen identifier source); (c) the registry cross-check uses that identifier, not the status field. §2.4.3 check 3 prose updated to explicitly name the `fixture_id` source. False-positive defense bullet for "Wrong fixture_id in `grandfathered` value" rewritten to "Trial fixture_id without registry coverage when `grandfathered` is emitted". | §2.4.2 (status semantics row) + §2.4.3 (check 3) + §2.4.3 (false-positive defense bullet) |

### §15.2 Codex r2 residual-cleanup disposition

| ID | Codex r2 finding | r3 Disposition |
|---|---|---|
| R2-RESIDUAL-1 | Residual "CI" terminology in non-binding sections (e.g., §1.4 "CI lint", "no CI check"; §3.5 "pre-tag-CI-stage"). Codex explicitly notes this "is not counted as a new r2 issue; it is an incomplete cleanup of prior MINOR 2." | **Out of r3 scope** — per dispatch hard-rule "this dispatch addresses ONLY the 2 new issues codex flagged." Codex's own §5 frames R2-RESIDUAL-1 as documentation polish on already-INTEGRATED prior MINOR 2, not a blocker. Carried forward as a **future-light-fix** item if a subsequent revision is opened on this ADR for any reason; otherwise the existing terminology is unambiguous in context (the binding §2.4.3 terminology note already defines "orchestrator-invoked pre-tag lint" as the operative term). |

### §15.3 Gemini r2 disposition

Gemini r2 returned ACCEPT (verdict §6) with no new issues (§4: "Decision-logic conflicts: None. r2 tightens enforcement mechanics ... without changing the core rule logic"). No r3 actions required from gemini.

### §15.4 r3 procedural recommendation

Per dispatch task: post-r3 review path = orchestrator dispatches **codex round-3 re-review** to confirm R2-N1 + R2-N2 fixes have landed correctly; **gemini round-3 re-review** to confirm no regression introduced by the YAML→JSON format change (gemini's prior ACCEPT was on the YAML form, so a sanity-check re-read on the JSON form is conservative). spec-document-reviewer subagent runs as pre-submit self-check (max 3 iterations per §14.2 light-cycle pattern). User F-option signoff after both round-3 reviewers ACCEPT.

**Risk surface for r3** (intentional minimization):
- §11 schema is functionally equivalent (fields preserved, format-only change). JSON parses identically robustly to YAML for codex MAJOR 3's machine-readability requirement.
- §2.4.2 `grandfathered` row is a clarification (no contract change) — the status enum domain is unchanged; the registry cross-check semantics are made explicit instead of implicit.

---

*End of ADR r3. Status remains `proposed` until spec-document-reviewer pass + cross-LLM round-3 re-review (codex + gemini) + user signoff. Per Phase 6 spec §10.3 + §11 item 3 + §3.3, this ADR's acceptance is INDEPENDENT of Phase 6 Q1/Q2/Q4 trial outcomes.*
