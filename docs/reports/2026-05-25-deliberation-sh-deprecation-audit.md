---
title: Deliberation sh-script vs skill capability audit
date: 2026-05-25
author: aigentry-orchestrator-analyst-deliberation-audit
type: deprecation-audit
scope: read-only
dispatch: state/dispatch/2026-05-25-deliberation-sh-deprecation-audit-dispatch.md
hypothesis: "3 deliberation sh files are legacy duplicates of 4 deliberation skills"
hypothesis_status: partial (confirmed for brain/auto-d.sh; gap-confirmed for brain/d.sh; falsified for deliberation/auto-d.sh)
---

# Deliberation sh-script vs skill capability audit (2026-05-25)

## Executive summary

- **Initial hypothesis ("3 sh = legacy, deprecate all") is partially confirmed.** Of the
  three files, one is a confirmed duplicate (DEPRECATE), one fills a real capability gap
  (MIGRATE-GAP), and one is load-bearing for the live skill workflow (KEEP).
- **3 ACTIVE references** found (not just historical). The live `deliberation` skill (both
  copies) explicitly directs users to `bash auto-deliberate.sh` in workflow §C, and
  `aigentry-brain/AGENTS.md` codifies the sh files as "automation backup."
- **Verdicts (orchestrator-accepted)**:
  - `aigentry-brain/auto-deliberate.sh` → **DEPRECATE** (functional subset of
    `aigentry-deliberation/auto-deliberate.sh`; AGENTS.md backup-only directive lets it go).
    Path: 30-day deprecation notice in brain/AGENTS.md → removal PR.
  - `aigentry-brain/deliberate.sh` → **MIGRATE-GAP** (keep short-term; file Track-B task to
    port no-MCP multi-CLI capability into `deliberation-gate` Silver fallback).
  - `aigentry-deliberation/auto-deliberate.sh` → **KEEP** (canonical reference
    implementation; lock in skill SKILL.md §C as the auto-invocation backbone).
- **Hypothesis status**: PARTIAL — confirmed for 1 file, gap-confirmed for 1, falsified for 1.

## G1. Capability matrix

Rows = capability; ✓ = present, ✗ = absent, ~ = partial / minimal.
Columns: B/aD = `aigentry-brain/auto-deliberate.sh`; B/D = `aigentry-brain/deliberate.sh`;
D/aD = `aigentry-deliberation/auto-deliberate.sh`; SK-D = `deliberation` skill;
SK-E = `deliberation-executor`; SK-G = `deliberation-gate`; SK-T = `deliberation-test`.

| Capability | B/aD | B/D | D/aD | SK-D | SK-E | SK-G | SK-T |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| MCP `deliberation_start`/`respond`/`synthesize` integration | ✓ | ✗ | ✓ | ✓ | ✗ | ✓ | ✓ |
| File-based deliberation (no MCP required) | ✗ | ✓ | ✗ | ✗ | ✗ | ~ (Silver self-criticism, single-model) | ✗ |
| Dynamic CLI speaker detection (PATH probe) | ✗ (claude+codex hardcoded) | ✗ (claude+codex hardcoded) | ✓ (6 CLIs: claude/codex/gemini/qwen/opencode/llm) | ✓ (`deliberation_speaker_candidates`) | ✗ | ✓ | ✗ (claude+codex+gemini hardcoded) |
| Configurable round count | ✓ (default 3) | ✓ (default 3) | ✓ (default 2, `--rounds N`) | ✓ (param) | n/a | ✓ (per preset) | ✓ (default 2) |
| Session resume (`--resume <id>`) | ✓ | ✗ | ✓ (loads state JSON) | ✓ (implicit via session_id) | n/a | ✗ | ✗ |
| Multi-session parallel | ✓ (via MCP) | ✗ | ✓ (via MCP) | ✓ (`deliberation_list_active`) | n/a | ~ | ~ |
| LLM-generated synthesis text | ✓ (Claude composes synthesis) | ✓ (Claude composes synthesis) | ~ (minimal metadata stub, no LLM text) | ✓ (`deliberation_synthesize`) | n/a (consumer) | ✓ (integration rules) | ✓ |
| Auto-orchestration of all turns | ✓ | ✓ | ✓ | ~ (user-driven via `route_turn`) | ✗ | ~ | ✓ (`deliberation_cli_auto_turn` loop) |
| Speaker role assignment (critic/implementer/etc.) | ~ (hardcoded prompts) | ~ (hardcoded prompts) | ~ (single generic prompt) | ✓ (`speaker_roles`, role_preset) | n/a | ✓ (scenario preset map) | ✓ |
| Browser LLM speakers (CDP / sidepanel) | ✗ | ✗ | ✗ | ✓ | n/a | ✓ | ✓ |
| User-approval gate before deliberation | ✗ | ✗ | ✗ | ✓ (`AskUserQuestion`) | n/a | ✓ (HARD GATE) | ✗ (auto) |
| Vote markers + role_drift validation | ✗ | ✗ | ✗ | ✗ | n/a | ✗ | ✓ |
| Project context auto-injection (brain/*.md frontmatter strip, 12k char cap) | ✗ | ✓ (UNIQUE) | ✗ | ~ (`deliberation_context` tool) | n/a | ✗ | ✗ |
| Obsidian auto-archive | ✗ (MCP-managed) | ✓ (explicit `cp`) | ✗ (MCP-managed) | ✓ (auto via MCP) | n/a | ✓ | ✓ |
| Handoff to implementation (executor) | ✗ | ✗ | ✗ | ✓ (documented handoff) | ✓ (consumer of synthesis) | ✓ (integration rules) | ✗ |
| MCP fallback / graceful degradation | ✗ | ✓ (no-MCP by design) | ✗ | ✗ | n/a | ✓ (self-criticism Silver) | ✗ |
| Context preset scenarios (brainstorm/review/debug) | ✗ | ✗ | ✗ | ✗ | n/a | ✓ (UNIQUE) | ~ (review preset) |

### Matrix takeaways

1. The 4 skills collectively cover all sh capabilities **except two**:
   `B/D`'s file-based-no-MCP path (only deliberation-gate Silver fallback approximates, and only
   single-model) and `B/D`'s brain/*.md context auto-injection.
2. `D/aD` is the only auto-script with **dynamic CLI detection across 6 CLIs**; the brain pair
   is hardcoded to claude+codex.
3. `B/D` is the only path that does NOT touch the MCP server — relevant if the
   `~/.local/lib/mcp-deliberation/index.js` server is uninstalled / broken / not in scope.
4. Browser LLM, user-approval gate, vote-marker validation, executor handoff, scenario presets:
   **skill-only**, no sh equivalent.
5. Synthesis quality: `B/aD` and `B/D` produce real LLM-generated synthesis; `D/aD` only emits
   a metadata stub (functional gap).

## G2. Active reference scan

Grep command per dispatch spec, executed across `~/projects/aigentry-*`, `~/.claude/skills/`,
and `~/.aigentry/`:

```bash
grep -rln "auto-deliberate.sh\|deliberate.sh" \
  ~/projects/aigentry-* ~/.claude/skills/ ~/.aigentry/ \
  --include="*.md" --include="*.sh" --include="*.json"
```

Plus extended scope (b) checks: `*.yml`, `*.yaml`, `Makefile`, `*.toml`, `install.js`,
`package.json`.

| # | File | Category | Notes |
|---|---|:---:|---|
| 1 | `aigentry-devkit/skills/deliberation/SKILL.md` (lines 99, 102, 105) | **A — ACTIVE** | Live skill (symlinked from `~/.claude/skills/deliberation/`). §C "자동 진행 (스크립트)" directs users to `bash auto-deliberate.sh "주제"`. Script name is unqualified — ambiguous which copy. |
| 2 | `aigentry-deliberation/skills/deliberation/SKILL.md` (lines 183, 186, 189) | **A — ACTIVE** | Canonical source of skill in `aigentry-deliberation` repo; same §C directive. |
| 3 | `aigentry-brain/AGENTS.md` (line 16) | **A — ACTIVE** | Governance policy: "쉘 스크립트(deliberate.sh, auto-deliberate.sh)를 안내하거나 제안하지 말 것. 스크립트는 자동화 백업용." Codifies sh files as backup-only role. |
| 4 | `aigentry-brain/state/email-reply-brain-half.md` | B — HISTORICAL | Past dispatch artifact. |
| 5 | `aigentry-deliberation/DELIBERATION-ISSUES.md` | C — DOCUMENTATION | Bug-fix history; mentions `auto-deliberate.sh` as the test/validation path during MCP client wrapper fix. |
| 6 | `aigentry-orchestrator/state/dispatch/2026-05-12-E-coder-brain-link-dispatch.md` | B — HISTORICAL | Past coder dispatch ref. |
| 7 | `aigentry-orchestrator/state/dispatch/2026-05-25-deliberation-sh-deprecation-audit-dispatch.md` | B — HISTORICAL | This audit's own dispatch (self-reference). |
| 8 | `aigentry-orchestrator/state/dispatch/2026-05-12-E-analyst-brain-email-dispatch.md` | B — HISTORICAL | Past analyst dispatch ref. |

(Self-references — the script files themselves — are excluded from the table.)

### Totals

- **A (ACTIVE, load-bearing)**: 3
- **B (HISTORICAL, irrelevant for deprecation)**: 4
- **C (DOCUMENTATION, informational)**: 1

### Extended scope (b) — MCP-less deliberation need

Searched for evidence that an MCP-less deliberation path is required anywhere:

- **CI configs**: `*.yml/.yaml/Makefile/*.toml` across all aigentry-* repos → no matches.
- **Package installer**: `aigentry-deliberation/install.js` → does NOT bundle/install any
  `*deliberate*.sh`. The npm package ships the MCP server only.
- **Bootstrap workflows**: no script invokes the sh files from a bootstrap context.
- **`deliberation-gate` Silver fallback**: covers the MCP-missing case but with
  *single-model self-criticism*, NOT multi-CLI. So `brain/deliberate.sh`'s "multi-CLI without
  MCP" capability is **structurally unique** in the ecosystem.

**Conclusion**: there is no automated workflow that requires MCP-less mode today, but the
capability gap (multi-CLI deliberation when MCP is unavailable) is real and only `brain/deliberate.sh`
fills it. Whether to keep filling that gap is a policy call (see Open Questions §3).

## G3. Per-sh-file verdict

### 1. `aigentry-brain/auto-deliberate.sh` — **DEPRECATE**

- **Rationale**: Functional subset of `aigentry-deliberation/auto-deliberate.sh` — same MCP
  integration path, but hardcoded to claude+codex (vs D/aD's dynamic 6-CLI detection); see
  matrix rows "Dynamic CLI speaker detection," "MCP integration," "Session resume" — all
  capabilities present in D/aD with broader coverage. AGENTS.md line 16 already classifies
  this script (and `deliberate.sh`) as backup-only and bans recommending it in conversation
  — i.e., its policy role is already minimal.
- **Unique-vs-D/aD differential**: only feature `brain/auto-deliberate.sh` has that D/aD
  lacks is **LLM-generated synthesis text** (matrix row). That capability should be ported
  to D/aD before this file is deleted (see KEEP block §3 follow-up).
- **Migration path**:
  - Users currently running `bash auto-deliberate.sh "주제"` from `aigentry-brain/` switch to
    `bash ~/projects/aigentry-deliberation/auto-deliberate.sh "주제"`, or invoke the
    `deliberation` skill via natural language.
  - No new command is required for interactive use — the skill auto-triggers on the keyword.
- **No code change in this dispatch.** Removal handled by a future deprecation-cycle dispatch
  (see Recommendation §A).

### 2. `aigentry-brain/deliberate.sh` — **MIGRATE-GAP**

- **Rationale**: Holds two capabilities NOT covered by any of the 4 skills (matrix rows
  "File-based deliberation no-MCP" and "Project context auto-injection brain/*.md"). The
  `deliberation-gate` Silver fallback degrades to single-model self-criticism — not the same
  as a real multi-CLI debate without MCP. This is a genuine capability gap, not redundancy.
- **Specific gaps the skills do not cover**:
  1. Multi-CLI deliberation (claude × codex) without `~/.local/lib/mcp-deliberation/index.js`
     being installed or running.
  2. Auto-loading `aigentry-brain/*.md` (frontmatter stripped, 80-line head, 12k char cap)
     into the deliberation file as `## 프로젝트 배경` — no skill has an equivalent
     project-knowledge auto-injection step.
  3. Self-contained `deliberation-active.md` + Obsidian copy with no MCP state entanglement.
- **Short-term action**: keep `brain/deliberate.sh` AS-IS — it remains the only path that
  delivers (1) and (2).
- **Long-term migration target**: port the no-MCP multi-CLI fallback capability into
  `deliberation-gate`'s Silver tier (currently single-model). Once Silver fallback can
  drive a real multi-CLI debate without MCP, the script can be retired and replaced by the
  skill. This is a Track-B follow-up task (see Recommendation §B).

### 3. `aigentry-deliberation/auto-deliberate.sh` — **KEEP**

- **Rationale**: Referenced from the live `deliberation` skill §C (both copies) as the
  canonical "자동 진행 (스크립트)" entry point — load-bearing for the documented skill
  workflow. Most feature-complete of the three (dynamic 6-CLI detection across
  claude/codex/gemini/qwen/opencode/llm, `--resume` via state JSON, cyclic ordering,
  JSON-RPC initialize+initialized handshake).
- **Lock-as-reference-implementation**: this script is the auto-invocation backbone for the
  skill's MCP browser/CLI auto-turn paths. The skill SKILL.md §C should explicitly label it
  as the reference implementation and note that `deliberation_cli_auto_turn` and the
  browser-CDP paths converge on the same MCP RPC pattern this script demonstrates.
- **Known gap (not blocking)**: synthesis is a metadata stub only (matrix row "LLM-generated
  synthesis text" = `~`). The brain pair has real LLM synthesis; D/aD does not. The brain
  synthesis prompt (`brain/auto-deliberate.sh` lines 222-238) should be ported here before
  `brain/auto-deliberate.sh` is deleted (otherwise the synthesis capability silently
  regresses in the ecosystem). Queued as a Track-B task.

## Recommendation

Structured per verdict — three sub-blocks. No code changes in this dispatch; this section
defines the follow-up dispatches.

### A. DEPRECATE — `aigentry-brain/auto-deliberate.sh`

Phased deprecation (no abrupt delete):

- **Action items**:
  1. Add a 30-day deprecation notice paragraph to `aigentry-brain/AGENTS.md` (a new
     "Deprecation notice" subsection under §Deliberation), stating that
     `brain/auto-deliberate.sh` is scheduled for removal and pointing users at
     `~/projects/aigentry-deliberation/auto-deliberate.sh`.
  2. Add a header comment to `aigentry-brain/auto-deliberate.sh` itself ("⚠️ DEPRECATED —
     scheduled removal 2026-06-24; use `aigentry-deliberation/auto-deliberate.sh`").
  3. After the 30-day window, file a removal PR that deletes the file and updates any
     remaining references.
  4. **Precondition before deletion**: port the LLM-synthesis composition step from
     `brain/auto-deliberate.sh` lines 222-238 into `aigentry-deliberation/auto-deliberate.sh`
     so the synthesis capability does not regress (see KEEP block follow-up).

### B. MIGRATE-GAP — `aigentry-brain/deliberate.sh`

Keep short-term, migrate the unique capabilities into a skill long-term:

- **Action items**:
  1. **Keep AS-IS short-term** — the file fills two real gaps (no-MCP multi-CLI; brain/*.md
     context auto-injection) that no skill currently covers.
  2. **File Track-B task** to extend `deliberation-gate` Silver fallback from single-model
     self-criticism to **multi-CLI no-MCP** mode. Use `brain/deliberate.sh` as the reference
     implementation for the prompt/round-loop structure.
  3. **File Track-B task** to add a brain-context auto-injection step to the `deliberation`
     skill (or to `deliberation_context` MCP tool) — frontmatter-strip + line-cap +
     char-cap logic from `brain/deliberate.sh` lines 27-41.
  4. Once both Track-B items land, queue a separate deprecation dispatch for
     `brain/deliberate.sh`.

### C. KEEP — `aigentry-deliberation/auto-deliberate.sh`

Lock as reference implementation; queue synthesis-quality follow-up:

- **Action items**:
  1. Update both `deliberation` SKILL.md copies (the devkit symlink target at
     `aigentry-devkit/skills/deliberation/SKILL.md` and the canonical
     `aigentry-deliberation/skills/deliberation/SKILL.md`) §C section to:
     - Use an absolute path: `bash ~/projects/aigentry-deliberation/auto-deliberate.sh "주제"`
       (eliminates the current `bash auto-deliberate.sh` ambiguity that lets cwd-relative
       picks happen).
     - Add a note labeling the script as the "reference implementation for the auto-turn
       backbone" used by `deliberation_cli_auto_turn` and the CDP browser auto-turn paths.
  2. **Port LLM-synthesis composition** from `brain/auto-deliberate.sh` lines 222-238 into
     `aigentry-deliberation/auto-deliberate.sh` so the synthesis text is real (not a
     metadata stub). This is a precondition for deprecating `brain/auto-deliberate.sh`
     (Action A.4).

### Timeline summary

| Phase | Action | Dispatch |
|---|---|---|
| Immediate | This audit report only | (this dispatch) |
| T+0 days | Port LLM synthesis from brain/auto-d.sh → deliberation/auto-d.sh (C.2); add deprecation notice to brain/AGENTS.md (A.1); update both SKILL.md §C copies (C.1) | next dispatch (coder) |
| T+0 days | Add deprecation header to brain/auto-deliberate.sh (A.2) | same dispatch |
| T+30 days | Removal PR for brain/auto-deliberate.sh (A.3) | follow-up dispatch |
| Indeterminate | Track-B: extend deliberation-gate Silver to multi-CLI no-MCP (B.2) | separate Track-B dispatch |
| Indeterminate | Track-B: brain-context auto-injection into skill / MCP tool (B.3) | separate Track-B dispatch |
| After both B tasks | Deprecate brain/deliberate.sh | follow-up dispatch |

## Open questions (for orchestrator)

1. **brain/deliberate.sh MCP-less fallback timeline** — when does `deliberation-gate`'s
   Silver fallback acquire multi-CLI mode (Recommendation B.2)? Is this a Q3/Q4 target, or
   indefinite "Track-B someday"? The longer the slip, the more `brain/deliberate.sh` becomes
   the de-facto MCP-less path — at which point it deserves promotion to first-class status
   rather than indefinite MIGRATE-GAP limbo.

2. **brain/auto-deliberate.sh deprecation announcement channel** — A.1 says "add a
   deprecation notice to brain/AGENTS.md," but is that the right channel by itself?
   Options:
   - **commit message banner**: visible in `git log` but not browsed.
   - **ADR entry** (e.g., `aigentry-brain/docs/adr/2026-05-25-deliberation-sh-deprecation.md`):
     formal but heavy.
   - **CHANGELOG.md**: standard, user-visible, lightweight.
   - **All three** (recommended): AGENTS.md (policy), CHANGELOG.md (user-facing notice),
     commit message (history). ADR optional — overkill for a script removal unless it sets
     a broader precedent.
   Orchestrator decision needed before A.1 dispatch is written.

3. **aigentry-devkit propagation of AGENTS.md backup-only directive** — `aigentry-brain/AGENTS.md`
   line 16 ("쉘 스크립트를 안내하거나 제안하지 말 것") currently applies only inside
   `aigentry-brain/`. But the symlinked skill at `aigentry-devkit/skills/deliberation/SKILL.md`
   §C actively recommends `bash auto-deliberate.sh`. After C.1 fixes the path in the skill,
   should `aigentry-devkit` also import (mirror) the AGENTS.md backup-only language so the
   policy is consistent across repos? Or is per-repo policy intentional?
   Recommended default: per-repo policy is intentional (brain owns brain context; devkit owns
   global skill text). C.1 is sufficient. But confirm.

4. **Implicit**: skill SKILL.md divergence (devkit copy 132 lines vs aigentry-deliberation
   copy 222 lines with extra MCP tools like `deliberation_inject_context`,
   `deliberation_run_until_blocked`, `deliberation_ingest_remote_reply`) is an
   out-of-scope finding. A separate skill-sync audit dispatch may be warranted.

## Boundary verification (G5)

- No code changes outside this report. All sh files unmodified.
- No SKILL.md edits.
- No commits, no deletions, no symlink changes.
- Single new file: this report at
  `/Users/duckyoungkim/projects/aigentry-orchestrator/docs/reports/2026-05-25-deliberation-sh-deprecation-audit.md`.

## Hypothesis status

**PARTIAL** — outcome per file:

- `brain/auto-deliberate.sh`: hypothesis **confirmed** — functional subset of
  `deliberation/auto-deliberate.sh`; deprecate (with phased timeline + synthesis port
  precondition).
- `brain/deliberate.sh`: hypothesis **gap-confirmed** — overlaps in surface but holds
  structurally unique capabilities (no-MCP multi-CLI + brain/*.md context auto-injection).
  Migrate the gap into skills (Track-B), then deprecate.
- `deliberation/auto-deliberate.sh`: hypothesis **falsified** — load-bearing for the live
  skill §C workflow; lock as reference implementation.

Net: 1/3 deprecate-now (phased), 1/3 deprecate-after-migration, 1/3 keep-as-canonical.
