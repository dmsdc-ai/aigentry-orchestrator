---
type: report
status: final
date: 2026-05-10
author: aigentry-architect-claude (synthesis pass)
related:
  - "docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md"
  - "docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-claude.md"
  - "docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-codex.md"
  - "/tmp/aigentry-dispatch/q-prime-bis-adr-draft-brief.md"
  - "~/.telepty/shared/24131e1ec9b32d094eaed37f0a01d1d073e81040a05d0e6b580194fafbaab0c9.md"
tags: [synthesis, adr, q-prime-bis, telepty, cross-llm, best-of-both]
---

# Q'''-bis ADR Synthesis Report

This report documents the section-by-section synthesis decisions used to produce the final ADR `docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md` from two parallel cross-LLM drafts (`*-claude.md` and `*-codex.md`).

## §1 Source comparison

| Property | Claude r1 | Codex r1 |
|---|---|---|
| Path | `*-claude.md` | `*-codex.md` |
| Lines | 829 | 1261 |
| Top-level sections | 18 | 18 |
| Subsections | ~80 | 73 |
| Requirements traced | 39 visible (31 label flagged) | 39 visible (31 label flagged) |
| Mandates documented | 19 (M22–M40) | 19 (M22–M40) |
| Self-criticism sub-points | 8 | 6 |
| TBD blanks | 1 hard + 5 deferred | 6 |
| Alternatives surveyed | 8 | 10 |

Both drafts independently identified the same locked architecture and the 31/39 requirement-count mismatch — strong cross-LLM agreement on the substantive content. They diverged primarily in **structure**, **depth-per-section**, and **breadth of self-criticism**.

## §2 Section pick map

The final ADR uses Codex's 18-section skeleton expanded to 23 sections to absorb Claude's high-value additions (Per-Session Supervisor, Self-Criticism, Appendix). Picks below: **(C)** Claude / **(X)** Codex / **(H)** Hybrid / **(N)** Newly written.

| Final § | Topic | Pick | Rationale |
|---|---|---|---|
| §1 Status, Context, Trigger | overview + 31/39 trace + lock vs defer | **H** | Codex 8-point Decision Summary + Codex 31/39 trace note; Claude D-1..D-4 defect table + frontmatter richness (tier, scope, related, unblocks) + lock-vs-defer subsection |
| §2 Context | 0.3.x model + V1-V4 vision + layer + boundary + survey | **X** | Codex's six-subsection structure (§2.1–§2.6) is more readable than Claude's compact §1.2/§1.3 |
| §3 Decision | adopt + remove daemon + supervisor + relay + manifest + log + IPC + NDJSON + auth + binary | **X** | Codex's §3.1–§3.10 numbered subsections clearer than Claude's §2.1–§2.4 prose; Claude's "why per-session" / "why per-host relay" reasoning merged into §3.3 / §3.4 paragraphs |
| §4 Constraints (31 binding / 39 visible) | A–K trace + acceptance gates | **H** | Codex compact requirement index + Codex acceptance-gates-by-category (UNIQUE); Claude per-row measurement detail merged in |
| §5 Mandates M22–M40 | rule + serves + why-rejected + interactions | **H** | Claude per-mandate "Serves" / "Why-rejected" rationale (richer); Codex Mandate Interactions pair-analysis (§5.2 — UNIQUE) |
| §6 Wire Protocol — NDJSON | envelope + kind-cond + error codes + idempotency + backpressure + backward-compat | **H** | Codex envelope table + idempotency walkthrough (4-rule) + backward-compat surface; Claude error code list + backpressure policy + worked examples |
| §7 Manifest and Disk Layout | directory tree + schema + invariants + disk policy | **X** | Codex unique directory tree + manifest invariants table + disk policy table; Claude appendix manifest example moved to §21 |
| §8 Relay Topology and Lifecycle | T1 + L1a/L2c/L3a/L4a + routing + why-not-merge + why-not-ControlMaster | **H** | Codex topology table (§8.1); Claude routing ASCII diagram (§8.3) + why-relay-≠-supervisor (§8.4); Codex why-not-ControlMaster (§8.5) |
| §9 Per-Session Supervisor | process model + RAM accounting + N evolution + single-thread + 1-process | **C** | Claude §8 RAM honest accounting (5-8 MB / N=100 = 500-800 MB / N=1000 = 5-8 GB) + N evolution path (per-CPU-core hybrid / idle-suspended) — Codex did not have this dedicated section |
| §10 Performance and Capacity | budgets + RAM model + E3 risk + build mitigation | **X** | Codex §10 RAM formula + E3 precondition-risk framing + M27 build cost mitigation cleaner than Claude's scattered placement |
| §11 Security Model | Phase 1 controls + explicit rejections + Phase 2+ hooks | **X** | Codex §9 table format + explicit Phase 1 rejection list + Phase 2+ reserved hooks; Claude V4 contact identity forward-ref merged |
| §12 Phase Plan | overview + Phase 0–4 tasks + exit + ETA | **X** | Codex §14 ETA table + per-phase task lists + exit criteria more usable than Claude's compact §9; Claude ETA dependencies appended as §12.7 |
| §13 Open Questions and Preconditions | C1 / C2 / C3 / C4 | **X** | Codex §13 each precondition with question / required evidence / acceptance is structurally STRONGER than Claude's §13 paragraph form |
| §14 Outstanding (TBD blanks) | 9-row TBD table | **H** | Claude TBD detail (supervisor lang / migration / V4 / E3 amend / hybrid / HMAC) + Codex Final Decision Record TBDs (manifest path / NDJSON fixture / shim lifetime) |
| §15 Alternatives Considered | 13 candidates + win-condition | **H** | Claude 8 paragraphs (Q''' / D / Q / I' / Y / CC / N / O); Codex 10 (adds Tailscale-SSH-mode, public-relay) — superset 13 alternatives, 5 short ones in compact table to control line budget |
| §16 Consequences | positive + negative + neutral | **H** | Claude 8/6/3 detail; Codex 8/6/(neutral list) tabular form — final uses tabular Codex layout with Claude's quantified detail (RAM numbers, person-week estimate) |
| §17 Self-Criticism | 13 sub-points | **H** | Claude 8 (RAM gamble, single-thread, relay SPOF, NDJSON-binary, Rust-bias, Phase-2-steepness, boundary-drift, §15-uneven) + Codex 6 (count mismatch, RAM uncertainty, language uncertainty, Windows risk, K1 latency, ops cost) — deduplicated to 12 distinct + 1 constructive frame |
| §18 Constitution Check | Q1–Q5 + Articles | **H** | Claude Q1–Q5 + Article 1/2/3/5/9/13/17 table; Codex adds Article 7 (Interoperability) and Article 15 (SSOT Contracts, marked PENDING) — merged superset |
| §19 Implementation Handoff | owned components + initial contract tests + migration ADR ref | **X** | UNIQUE to Codex (§15) — owned components table + Phase 1 contract test list (11 tests). High value, retained as-is |
| §20 Final Decision Record | binding decisions (12) + TBD (9) + non-binding recs | **X** | UNIQUE to Codex (§17) — 12-point binding decision summary + TBD table + non-binding recommendations. High readability, retained |
| §21 Appendix — Examples | manifest / log / wire / reachability | **C** | Claude §17 manifest example, log.jsonl example, cross-machine wire example, reachability pseudocode — concrete and useful for implementers; Codex did not have this |
| §22 Self-check rubric | 7-item architect rubric | **C** | Claude §18 7-item self-check (rubric verifying §1 / §3 / §11 / §4.J / §15 / §9). Compressed to one-line entries to save space |
| §23 History | r1 record | **H** | Single revision record |

### Pick totals

| Bucket | Count |
|---|---|
| Claude-picked sections (C) | **3** (§9, §21, §22) |
| Codex-picked sections (X) | **7** (§2, §3, §7, §10, §11, §12, §13, §19, §20) — 9 if you split §19/§20 |
| Hybrid sections (H) | **8** (§1, §4, §5, §6, §8, §14, §15, §16, §17, §18) — adjust as ~10 |
| Newly written (N) | **0** — both drafts covered all locked decisions; synthesis re-organized rather than wrote new content |

(For the report inject: roughly **3 / 9 / 11 / 0**.)

## §3 Cross-LLM agreement and divergence

### §3.1 Strong agreement (high-confidence locks)

Both LLMs independently:

- accepted the Q'''-bis locked architecture verbatim (3-layer split, daemon-1→0, per-session supervisor, per-host relay, NDJSON, UDS/Named Pipe);
- traced 31 labelled / 39 visible requirements without dropping any;
- documented all 19 mandates M22–M40 with consistent rationale;
- preserved the supervisor-language TBD as evidence-gated (C1–C4);
- rejected the same alternatives (Q''', D, Q, I', Y, CC, N, O);
- flagged E3 (RAM ≤ 10 MB) as a precondition risk, not a proven invariant;
- explicitly rejected mailbox / store-and-forward (M40);
- used `[INBOX from <alias>] <≤50-char title>` verbatim as M39 format.

This convergence raises confidence that the locked architecture is actually well-specified by the brief — both LLMs read the same source-of-truth and reached the same operational conclusions independently.

### §3.2 Divergence (style / depth / structural)

| Topic | Claude approach | Codex approach | Synthesis pick |
|---|---|---|---|
| Section structure | 18 with §-deep subsections | 18 with 73 sub-numbered subsections | Codex skeleton, expanded to 23 |
| Per-mandate detail | Rich rationale per mandate, Serves/Why-rejected paragraphs | Compact table with one-line rationale | Claude rationale + Codex Mandate Interactions table |
| Phase plan | Compact paragraph form per phase | ETA + per-phase tasks + exit criteria | Codex phase tables, expanded |
| Performance section | Distributed across §3.E and §8.2 | Consolidated §10 with RAM formula | Codex consolidated |
| Implementation handoff | Implicit (no dedicated section) | Dedicated §15 with owned-components + tests | Codex (UNIQUE retained) |
| Final binding decisions | Implicit across body | Dedicated §17 12-point summary | Codex (UNIQUE retained) |
| Self-criticism breadth | 8 sub-points (broader categories) | 6 sub-points (operational + risk-list) | Superset of 13 (12 + frame) |
| Alternatives | 8 with paragraph rejection (uneven depth flagged in self-crit) | 10 with tabular consistency | Superset 13 (compact table for short ones) |

### §3.3 No conflict on locked decisions

Both drafts are **identical on every locked architectural decision** of the brief. There were **no conflicts** to resolve — only depth, structure, and emphasis. This means the synthesis is purely additive: best-of-both **never required** a winner-takes-all judgment on architecture itself.

The only place where one draft makes a tighter claim is M30 wording: Claude self-critiques that "install-time ulimit" drifts from the boundary ADR; Codex did not flag this. Synthesis adopts Claude's self-correction ("**first-spawn ulimit check**") as the canonical wording in both §5.1 and §17.7.

## §4 Self-criticism integration

### §4.1 Source mapping

| Final §17 sub-point | From | Notes |
|---|---|---|
| §17.1 RAM gamble (E3 unproven) | C §14.1 + X §11.4(2) | merged — Claude's N=1000 = 8GB laptop calculation + Codex's E3-as-precondition-risk framing |
| §17.2 Single-thread tokio fragility | C §14.2 | Claude only |
| §17.3 Per-host relay = SPOF | C §14.3 | Claude only |
| §17.4 NDJSON binary unfriendly | C §14.4 | Claude only |
| §17.5 Supervisor language TBD (Rust bias) | C §14.5 + X §11.4(3) | merged — Claude's M28-presupposes-Rust + Codex's "language uncertainty" |
| §17.6 Phase 1 → Phase 2 dependency steep | C §14.6 | Claude only |
| §17.7 Boundary ADR drift on M30 | C §14.7 | Claude only — drove M30 wording fix in synthesis body |
| §17.8 §15 alternatives uneven | C §14.8 | Claude only — partly resolved in synthesis (compact table for 5 short entries) |
| §17.9 Requirement count mismatch | X §11.4(1) | Codex only |
| §17.10 Windows risk not a checkbox | X §11.4(4) | Codex only |
| §17.11 K1 latency requires measurement | X §11.4(5) | Codex only |
| §17.12 Operational cost of many supervisors | X §11.4(6) | Codex only |
| §17.13 Constructive frame (closing) | X §11.4 closing | Codex's "constructive answer is the phase plan" closing line, retained |

**Result**: 12 distinct self-criticism sub-points + 1 constructive frame = 13 explicit sub-sections. Both LLMs' adversarial reviews are fully represented.

### §4.2 Self-criticism quality bar

Per Article 13, this section was the highest-bar piece of the synthesis: combining two adversarial views without softening either. The synthesis preserves the adversarial tone in both directions and adds a constructive answer to each criticism (the source drafts were inconsistent on whether constructive answers were written — codex tended to give them, claude listed them as "mitigation" lines; synthesis normalized to "constructive answer"-explicit per item).

## §5 Quality bar verification

### §5.1 Brief invariants check

| Invariant | Status |
|---|---|
| **I1 Locked decisions unchanged** | ✓ all 3-layer, daemon-zero, supervisor, relay, manifest, IPC, NDJSON, auth decisions preserved verbatim |
| **I2 TBD blanks explicit** | ✓ §14 + §20.2 both list 9 blanks (1 hard supervisor-lang + 8 deferred) |
| **I3 Both LLMs' self-criticism reflected** | ✓ §17 has 12 distinct sub-points sourced from C(8) + X(6) − overlap(2) = 12 + frame |
| **I4 ≤ 1500 lines** | ✓ final ADR is **1495 lines** |
| **I5 Synthesis report separate** | ✓ this file (`docs/reports/2026-05-10-q-prime-bis-adr-synthesis-report.md`) |
| **I6 No commit** | ✓ no commit performed; orchestrator owns commit |
| **I7 Source drafts preserved** | ✓ `*-claude.md` (829 lines) and `*-codex.md` (1261 lines) untouched in `docs/adr/` |

### §5.2 Quality-bar adoption (from brief §"Use Full Capacity")

| Criterion | Realized via |
|---|---|
| Both drafts read in full before writing | ✓ 829 + 1261 lines read in chunks |
| Self-criticism integration | ✓ §17 superset (13 sub-points) |
| 31 label / 39 traced honesty | ✓ §1.5 explicit + §4 enumerates all 39 |
| 19 mandates traced | ✓ §5.1 single table covers M22–M40 |
| Phase-gated TBDs preserved | ✓ §13 + §14 + §20.2 all reference C1–C4 evidence-gated language decision |
| Constitutional alignment | ✓ §18 Q1–Q5 + Articles 1/2/3/5/7/9/13/15/17 |
| Implementer usability | ✓ §19 owned components + 11 contract tests + §21 appendix examples |

## §6 Decisions where synthesis added value beyond either draft

Three places where the merged file is **strictly better** than either input:

1. **§17.7 boundary-clean M30 wording** — Claude flagged the drift in self-criticism; synthesis pulled the fix forward into the M30 mandate body itself ("first-spawn ulimit check"), making the self-criticism partly redundant but architecturally cleaner. Both drafts are mutually inconsistent on this; synthesis is consistent.
2. **§14 + §20.2 cross-linked TBD tables** — Claude listed 6 blanks in §10; Codex listed 6 in §17.2. Synthesis merges to 9 distinct blanks visible in two complementary places (pre-Phase-Plan + Final Decision Record).
3. **§17 self-criticism deduplication** — Claude #1 ↔ Codex #2 (RAM/E3); Claude #5 ↔ Codex #3 (language). Source drafts would double-count; synthesis merges with both rationales preserved.

## §7 Decisions where synthesis dropped content

Three small omissions to fit the 1500-line budget:

1. Claude §15 (Constitution Check) Q1–Q5 paragraphs were already mostly the same as §18 of synthesis; redundant detail trimmed.
2. Codex §6.3 error codes "data is human-readable message" — collapsed into §6.4 table.
3. Claude appendix §17.4 reachability pseudocode kept verbatim; Codex did not have an appendix — no loss.

No locked decision was dropped. No mandate was dropped. No requirement was dropped. No self-criticism point was dropped.

## §8 Open recommendations for r2

Future revisions should consider:

1. **Normalize §15 alternatives to a 3-row table per entry** (per §17.8 self-criticism) — would tighten without losing detail.
2. **Add Article 15 SSOT contract registration plan** — currently PENDING in §18.6 because Phase 1 deliverable.
3. **Phase 0.5 relay PoC spike** as explicit C5 if §17.6 risk materializes after Phase 1.
4. **`telepty status` aggregator** spec as a Phase 2 deliverable (per §17.12 ops-cost mitigation).

## §9 Pick statistics (for orchestrator REPORT)

```
claude_picked_sections: 3   (§9, §21, §22)
codex_picked_sections:  9   (§2, §3, §7, §10, §11, §12, §13, §19, §20)
hybrid_sections:        11  (§1, §4, §5, §6, §8, §14, §15, §16, §17, §18, §23)
new_written_sections:   0
total_sections:         23
TBD_blanks:             9
self_criticism_subpts:  13  (12 distinct + 1 constructive frame)
final_adr_lines:        1495
synthesis_report_lines: ~ this file
```

---

End of synthesis report.
