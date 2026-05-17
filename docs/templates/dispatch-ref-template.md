---
dispatch_kind: fresh-session   # fresh-session | re-dispatch
# fresh-session: receiver has NO prior orchestrator context. Inline excerpts + path disclaimer MANDATORY.
# re-dispatch:   receiver already loaded prior dispatch ref or has persistent project context. Name-only citation OK.
---

# Dispatch Ref Template — Canonical Skeleton

> **Purpose**: Hardened, self-contained skeleton for every orchestrator → session dispatch.
> **Origin**: Permanent fix for task #396 (fresh-session can't fetch jargon-by-name) + task #397 (silent wait violates §13).
> **Status**: Canonical. New dispatches MUST use this skeleton. Re-dispatches MAY relax inline-excerpt rule per `dispatch_kind`.
> **Rule of thumb**: If the receiver is a fresh `claude` / `codex` / `gemini` process spawned with this file as its only context, can it execute end-to-end without fetching any other file in this repo? If NO → not self-contained → fix before dispatch.

---

## How to use this template

1. Copy this file to `state/dispatch/YYYY-MM-DD-<topic>-dispatch.md`
2. Set `dispatch_kind` front-matter (fresh-session OR re-dispatch)
3. Fill every `<placeholder>` — leave NO unsubstituted angle-brackets
4. If `dispatch_kind: fresh-session` → fill `## Inline excerpts` with every cited Rule/§/envelope verbatim
5. If `dispatch_kind: re-dispatch` → name-only citation OK, but receiver must demonstrably have prior context (e.g., chained from previous dispatch with explicit "carry-over" note)
6. Run the companion checklist `docs/templates/dispatch-ref-checklist.md` BEFORE injecting

---

## Skeleton (sections in canonical order)

```markdown
# Dispatch — <session-name> — <one-line task summary>

> **THIS FILE IS THE COMPLETE SELF-CONTAINED SPEC.** No external files referenced are required to act.
> Any `state/...` / `docs/...` / `bin/...` paths inside refer to **orchestrator-side metadata** —
> they are NOT files the receiver must locate or fetch.

## Role
You are `<session-id>`, role = <coder|builder|tester|analyst|architect|logger|...>.
Scope = `<repo path>` <only|primarily, may touch <sibling> for <reason>>.
Boundaries: <what NOT to touch, e.g., "no cross-repo edits", "code reads OK; production edits limited to X">.

## Background (inline — no prior context assumed)
<2-5 paragraphs of self-contained task context. State facts the receiver needs.
Do NOT cite ticket numbers, ADR identifiers, rule names, or prior conversation
WITHOUT a 1-line inline gloss of what each is. If a fact lives in another file,
quote the relevant sentence here.>

## Goal
<Verifiable success criteria, ideally testable. Bullet list of 1-5 items.
Each item should be observable from outside the session (file exists,
command exits 0, REPORT contains X, etc.).>

## Constraints
- **Constitution §<N> <name>**: <1-line application to this task>
- **Rule <N> <name>**: <1-line application to this task>
- (cite by name + §; verbatim quote lives in §Inline excerpts below)

## Workflow (Stop after each phase + HOLD inject)

### Phase 1 — <name> (no writes | writes-OK)
1. <step>
2. <step>
3. HOLD inject (format below) before proceeding

### Phase 2 — <name> (after Phase 1 approval)
1. <step>
2. HOLD inject before proceeding

### Phase N — REPORT
Final REPORT inject (format below).

## HOLD inject protocol (silent waiting forbidden)

**Format (single line, sent via real `telepty inject` — NOT printed as markdown):**
```
HOLD: <task-tag> | phase: <N>/<total> awaiting | reason: <one-line of what happened + what's needed> | needs: <specific decision the orchestrator must make>
```

**Send via:**
```bash
telepty inject --submit --from <session-id> <orchestrator-session-id> "HOLD: ..."
```

**Critical**: A HOLD printed inline in your reply is NOT a HOLD — it is a silent wait that pattern-matches §13 violation. The orchestrator only sees your `telepty inject` calls, not your inline markdown.

**When to HOLD**:
- Every phase boundary (even if you think the next step is obvious)
- Every self-correction mid-phase (about to deviate from spec)
- Every ambiguity / missing fact that blocks progress
- Before ANY destructive action (force push, tag delete, file rm)

Silent waiting at any of the above = Constitution §13 violation = task #397 reproduction.

## REPORT format (final phase)
```bash
telepty inject --ref --submit --submit-retry 2 --from <session-id> <orchestrator-session-id> "REPORT: <task-tag>-DONE | <key1>: <value> | <key2>: <value> | task: #<issue-number>"
```

## [SAWP] envelope (Rule 17 — MANDATORY in every dispatch)

After completing this task:
- Code + compile check only (e.g., `cargo check`, `swift build`, `tsc --noEmit`); do NOT run app (builder handles execution)
- Do NOT run tests (tester handles tests)
- If compile error → fix immediately; do NOT report "ready for builder" with broken code
- If stuck after 3 attempts → report STUCK with full error, do NOT loop silently
- Never idle — REPORT immediately when done; HOLD immediately when blocked
- Evidence only — no "should work" / "probably fixed" / "looks correct"
- Preserve ALL existing fixes in modified files (read file invariants before edit)

> **Note**: The verbatim text above is the **coder-role example** from `docs/sawp.md`. Other roles (architect, analyst, logger, builder, tester) substitute the corresponding role section from `docs/sawp.md` — the SAWP **essence** is the role-specific post-task workflow envelope, but the verbatim text is role-dependent. For role boundaries (who builds, who tests, who logs, who analyzes runtime, who designs), see the role-separation table in `docs/sawp.md` (must be inlined here for fresh-session dispatches).

Full envelope + role-separation table: `docs/sawp.md` (orchestrator-side; quoted above for self-containment).

## Inline excerpts (every cited Rule/§/envelope quoted verbatim)
<For dispatch_kind: fresh-session — REQUIRED. For each citation in §Constraints,
§Background, or §Workflow above, paste the verbatim quote here. Receiver must
NOT need to open another file to act.>

**Constitution §<N> <name>:**
> <verbatim quote>

**Rule <N> <name>:**
> <verbatim quote>

## Snyk (per ~/.claude/CLAUDE.md global "Snyk Security At Inception")
<One of:>
- **Applicable**: After <which phase>, run `snyk_code_scan` (MCP) or `bin/snyk-scan.sh` (shell) on <files>. Findings must be 0 before <which gate>. Loop fix-rescan until clean.
- **N/A — <reason>**: e.g., "bash script, not Snyk-supported language" / "docs only, no first-party code" / "scaffold template, no executable code"

## Boundary (do-not list + escalation triggers)
- Do NOT <action>
- Do NOT spawn additional sessions <unless authorized>
- Do NOT modify <out-of-scope files/repos>
- Escalate to orchestrator (HOLD inject) if: <condition 1>, <condition 2>, ...

## Full capability (tools + skills authorized)
<list of tools: Read + Edit + Bash + Glob + Grep + ...>
<list of skills: /skill-name (if needed), or "no external skills">
<MCP servers: e.g., mcp__snyk__* (if needed)>
```

---

## Section count & length guard (Constitution §1 lightweight)

Each section ≤30 lines. Whole template ≤350 lines.
If your dispatch needs more, split into multiple dispatch refs (one per phase) and chain them — do NOT expand a single ref past 350 lines.

## Counter-examples (what NOT to do — Constitution §13 objective)

**❌ Anti-pattern 1 — Name-only citation to fresh session (task #396 root cause):**
```
## Constraints
- Rule 13 builder role
- Constitution §1 lightweight
- ADR-MF #6 layered instructions
```
Fresh receiver: "Rule 13? Constitution §1? ADR-MF #6? Where do I find these?" → halts asking for clarification → 1 wasted round-trip.

**✓ Fix:** Cite by name in §Constraints, then quote verbatim in §Inline excerpts.

**❌ Anti-pattern 2 — Implicit Stop without HOLD inject (task #397 root cause):**
```
## Workflow
### Phase 1 — Audit
1. Read files X, Y, Z
2. Stop and wait for orchestrator.
```
Receiver reads "Stop and wait" → silently waits → orchestrator dead-reckons → user surfaces "왜 그냥 대기?" → §13 violation.

**✓ Fix:** Replace "Stop and wait" with explicit HOLD inject format + the actual `telepty inject` command.

**❌ Anti-pattern 3 — Orchestrator-side path leak:**
```
## Background
See state/task-queue.json task #396 for context.
```
Receiver: tries to read `state/task-queue.json` → file doesn't exist in their cwd OR is orchestrator-only metadata → confusion.

**✓ Fix:** Front disclaimer ("any `state/...` paths are orchestrator-side metadata, not files you need to fetch") + inline the relevant task context in §Background.

**❌ Anti-pattern 4 — HOLD as markdown (not as inject):**
```
[in receiver's reply]
```
HOLD: my-task | phase: 1/3 awaiting | reason: ... | needs: ...
```
```
Receiver thinks they sent a HOLD. Orchestrator never sees it (only sees telepty inject calls). Silent wait → §13 violation.

**✓ Fix:** HOLD is ALWAYS a `telepty inject` shell call. Print the call AND execute it. Markdown HOLDs in replies are not received by the orchestrator.

## Glossary (cited identifiers — flat, no external lookup)

- **Rule N** — orchestrator-side rule from `aigentry-orchestrator/docs/rules.md` (full text) summarized in `AGENTS.md` (checklist + summary). Cite by name + § + verbatim excerpt.
- **Constitution §N** — aigentry constitution article from sibling `aigentry/docs/CONSTITUTION.md`. 18 articles. Cite by § + name + verbatim excerpt.
- **ADR-MF #N** — multi-foundation ADR sequence in `aigentry-orchestrator/docs/adr/`. Cite by # + topic + verbatim excerpt if rule-load-bearing.
- **[SAWP] envelope** — Session Autonomous Workflow Protocol. Full text in `docs/sawp.md`; quote verbatim per Rule 17.
- **dispatch_kind** — front-matter flag (this template). `fresh-session` requires inline excerpts; `re-dispatch` permits name-only citation.
