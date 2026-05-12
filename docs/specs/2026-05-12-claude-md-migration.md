# SPEC — ADR-MF #6 CLAUDE.md → layered (common + role-orchestrator) migration

- Status: DRAFT (E-coder-mf6-migrate, 2026-05-12) — awaiting orchestrator approval
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.4 + §4.5 + §6 task #6
- Depends on: commit `28f94b0` (ADR-MF #4 resolver / #114) + commit `426f3a9` (ADR-MF #13 boot adapter / #104). Both **landed**; anti-leak invariant is satisfied because L1 child boot now suppresses cwd autoload (`--bare` + scratch control cwd).
- Constitution: Article 1 경량 (SPEC ≤250 lines; impl ≤200 LOC; tests ≤200 LOC; installer Δ ≤50 LOC); Article 17 무의존 (shell + Node stdlib only); Rule 29 외과적 변경 (only `CLAUDE.md` + new layered files + installer Δ; AGENTS.md untouched).

---

## 1. Why this migration

ADR §4.4 mandates `effective_prompt = common ⊕ project ⊕ role ⊕ task`. Today the orchestrator role contract lives mixed into `CLAUDE.md` at the repo root. Two structural problems:

1. **Layer violation.** `CLAUDE.md` carries role-specific dispatch protocols (telepty inject patterns, skill routing list, dustcraw feed, "code modification forbidden"). The resolver (#114) has nothing to load for the `role` layer of an `orchestrator` spawn — `~/.aigentry/instructions/roles/orchestrator.md` is the installer placeholder (`bin/install-instructions.sh:43-49`).
2. **Past leak channel.** Pre-#13, any L1 child spawned in `aigentry-orchestrator/` cwd auto-loaded `CLAUDE.md` and assumed orchestrator identity (today's incident, ADR §1). #13/#104 closed the boot leak; #6 now closes the *content* leak by relocating the role-heavy material into a path the resolver explicitly composes.

After this migration: orchestrator spawns get role content via resolver layers; the cwd `CLAUDE.md` is a thin pointer file kept only for direct-launch ergonomics (user running `claude` in the orchestrator repo) and back-compat.

---

## 2. Scope

In scope:

- Audit + categorization of current `CLAUDE.md` (20 lines, no `CLAUDE-ORCHESTRATOR.md`).
- New file content for `~/.aigentry/instructions/roles/orchestrator.md` (role-heavy migrated material).
- (Conditional, OQ#1) New content for `~/.aigentry/instructions/common.md`.
- `CLAUDE.md` rewrite as minimal stub.
- `bin/install-instructions.sh` Δ — embed real `orchestrator.md` (and optionally `common.md`) content instead of placeholder strings; preserve idempotency; add `--force` flag.
- Migration log + rollback procedure.
- Tests (TS + bash, ≥8 scenarios).

Out of scope:

- AGENTS.md edits (per dispatch — touch only if "absolutely necessary"; this SPEC concludes "no").
- `GEMINI.md` migration (orchestrator-flavored, 11 lines; OQ#3).
- Other 8 role files (`coder.md`, `architect.md` …) — placeholders stay as-is; this migration is orchestrator-only.
- Resolver / boot adapter changes (#114 + #104 already shipped).
- Symlinks back to `CLAUDE.md` (anti-leak: explicitly forbidden by ADR §6 #6 dependency note, even though #13 is now active — there is no legitimate use for them).

---

## 3. Content audit + categorization

Current `CLAUDE.md` (20 lines, sha256 to be captured in migration log §F):

| Line(s) | Content | Category | Rationale |
|---|---|---|---|
| 1 | `@AGENTS.md` | **stub-keep** | Claude-code autoload notation; lets direct-launch `claude` in this repo still see AGENTS.md. Not "common" content; a file-level cross-link. |
| 3 | `# Claude Code — Orchestrator` | **role-orchestrator** (rewrite) | Heading reframed as role contract in `roles/orchestrator.md`. |
| 5 | `## Claude 전용 설정` | **deprecated** | Renaming as "role" content removes the "Claude 전용" framing (resolver is CLI-agnostic at the role layer; per-CLI nuance is the boot-adapter's job, ADR §4.5.1). |
| 7-13 | telepty list dynamic session-ID resolver + `--submit-retry` / `--submit-force` flag policy | **role-orchestrator** | Dispatch behavior unique to the orchestrator role (other roles report *to* the orchestrator; they don't run the resolver snippet). |
| 14 | `superpowers 필수: "/using-superpowers로 진행해줘"` | **role-orchestrator** | Delegation-side instruction. The orchestrator embeds this in inject payloads; other roles do not. |
| 15 | Skill routing list (`orchestrate-turn`, `telepty-deliberate`, `auto-multi-llm-review`, `deliberation-executor`, `deliberation-gate`, `brainstorming`, `orchestrator-response-style`) | **role-orchestrator** | All listed skills are orchestrator-specific coordination skills. |
| 16 | 풀 역량 지시 ("가지고 있는 모든 스킬…100% 활용") | **role-orchestrator** | Delegation-payload boilerplate the orchestrator inserts. |
| 17 | `python3 ~/projects/aigentry-orchestrator/bin/session-layout.py` | **role-orchestrator** | Orchestrator-side grid bookkeeping after spawn/cleanup. |
| 18 | dustcraw 태스크 피드 | **role-orchestrator** | Orchestrator-driven autonomous feed loop. |
| 19 | 코드 수정 금지 (Rule 4 manifest) | **role-orchestrator** | Behavioral contract that defines the orchestrator role. |

**Totals:** 0 lines common-eligible, 17 lines role-orchestrator-eligible (counting wrapped content lines 7-19), 1 line deprecated heading (line 5), 1 line stub-keep (line 1). Lines 2, 4, 6 are blank separators.

**`CLAUDE-ORCHESTRATOR.md` audit.** File does not exist in repo. Per ADR §1 (Q-F1F3 = c, F1+F3 both required) and §6 task #6 wording, the *file* was anticipated but the F3 split was never authored in the legacy structure; it is being *born* into the new layered structure as `roles/orchestrator.md`. Treating this as "the destination file" rather than "a missing source" — no merge required. See OQ#2.

**Ambiguous / boundary cases (surfaced for orchestrator review):**

- **Line 1 `@AGENTS.md`** — Could argue "common-layer content should be the AGENTS.md superset". This SPEC chooses to keep the `@`-reference at the *file* level in the stub, not inside `common.md`, because (a) `@`-syntax is Claude-CLI-specific autoload notation and the resolver-composed `effective_prompt` is CLI-neutral, (b) AGENTS.md is loaded into the spawn pipeline via different paths (see ADR §4.5 global-snapshot policy). OQ#4.
- **Article-level invariants in AGENTS.md** (Article 1 경량, 17 무의존, Rule 29) — these *are* genuinely common across all roles. They live in AGENTS.md today, not CLAUDE.md. Per dispatch ("Touch AGENTS.md only if absolutely necessary"), this SPEC does **not** extract them. If/when a later task wants real common content, AGENTS.md is the source. OQ#1.
- **`GEMINI.md`** (11 lines, orchestrator-flavored, `aigentry-orchestrator-gemini` hardcoded session ID — violates AGENTS.md Rule 16). Boundary case: same role (orchestrator), different CLI surface. Out of scope; flag for follow-up task. OQ#3.

---

## 4. Target file contents

### 4.1 `~/.aigentry/instructions/roles/orchestrator.md` (NEW — ≤30 lines)

```markdown
# Role: orchestrator

The orchestrator is the aigentry ecosystem's control tower. It coordinates and
delegates; it does not execute code itself.

## Dispatch protocol

- Session IDs are runtime-resolved via `telepty list --json`; never hardcoded
  (AGENTS.md Rule 16). Standard dispatch from a sub-session back to the
  orchestrator:
  ```
  ORCH_ID=$(telepty list --json | python3 -c "import json,sys; print(next(s['id'] for s in json.load(sys.stdin) if 'orchestrator' in s['id'] and not any(x in s['id'] for x in ('coder','reviewer','architect','runner','dustcraw','analyst','builder'))))")
  telepty inject --ref --submit --submit-retry 2 --from <self-id> "$ORCH_ID" "REPORT: ..."
  ```
  - `--submit-retry N` (telepty ≥0.3.3, recommend N=2): idempotent retry on
    retry-safe 504 reasons.
  - `--submit-force` (telepty ≥0.3.3): bypasses the submit gate. Reserved for
    self-report / verified idempotent cases. Not the default.

## Delegation payload requirements

- Include `/using-superpowers` to ensure delegated sessions invoke their skill.
- Include the full-capability directive: "가지고 있는 모든 스킬, 도구, MCP
  서버, 워크플로우를 100% 활용".
- Skill routing (always_on first): `orchestrate-turn`, `telepty-deliberate`,
  `auto-multi-llm-review`, `deliberation-executor`, `deliberation-gate`,
  `brainstorming`, `orchestrator-response-style`.

## Lifecycle

- After every session register/exit run
  `python3 ~/projects/aigentry-orchestrator/bin/session-layout.py` to
  rebalance the grid.
- On every session completion proactively feed the next task into
  dustcraw (dustcraw 태스크 피드).

## Hard rule

- The orchestrator does NOT modify code. All implementation / analysis /
  research is delegated. Subagents are limited to orchestrator-shape work:
  spec drafting, session-state inspection, task decomposition.
```

### 4.2 `~/.aigentry/instructions/common.md`

**Decision:** keep the existing installer placeholder (`bin/install-instructions.sh:37-41`). No real common content is being relocated *from* `CLAUDE.md` in this migration (audit §3 = 0 common lines). Promoting AGENTS.md content into `common.md` is a separate task and out of scope (dispatch: "Touch AGENTS.md only if absolutely necessary"). OQ#1.

### 4.3 `CLAUDE.md` (post-migration stub — target ≤15 lines)

```markdown
@AGENTS.md

# Claude Code entry stub

This file is intentionally minimal. The orchestrator role contract is now
composed by `resolveInstructions()` (ADR-MF #4 / commit 28f94b0) from
layered files at `~/.aigentry/instructions/`:

- common: `~/.aigentry/instructions/common.md`
- role  : `~/.aigentry/instructions/roles/orchestrator.md`

L1 sub-sessions launched via the boot adapter (ADR-MF #13 / commit 426f3a9)
do NOT load this file — they receive `effective_prompt` directly. This stub
exists so a user who runs `claude` directly in this repo still sees the
AGENTS.md cross-reference.

Migration log: `state/migration/2026-05-12-claude-md-migration.md`.
```

Target line count: 14 lines (well under the <30-line test threshold). No role-heavy content remains.

### 4.4 `bin/install-instructions.sh` Δ (≤50 LOC delta)

Changes:

1. Replace the orchestrator role-file placeholder body (lines 43-49 of current installer) with the §4.1 content via heredoc. All other 8 role files keep their generic placeholder (out of scope).
2. Add `--force` flag: if set, overwrite existing files; otherwise preserve current idempotent behavior (existing file → skip).
3. New helper `ensure_file_force()` parallels `ensure_file()`.
4. Preserve POSIX-safe `${HOME:-$HOME}` style, `set -euo pipefail`, prefix honoring `$AIGENTRY_HOME` (unchanged from #114).
5. Print "updated file" vs "exists file" vs "created file" tri-state for `--force` visibility.

Delta budget: estimated +40 LOC (heredoc body + flag parsing + force helper). Stays within ≤50 LOC.

---

## 5. Tests (≥8 scenarios; TS strict + bash)

Framework: `node --test` for TS, `tests/bash/*.sh` for shell (matches existing `tests/` layout).

| # | Scenario | Layer | Validates |
|---|---|---|---|
| 1 | **Audit ledger** — sum(common-lines) + sum(role-lines) + sum(deprecated-lines) + sum(stub-keep) == lines(original CLAUDE.md). Every original line accounted for. | bash | Categorization completeness §3. |
| 2 | **Post-migration CLAUDE.md size** — `wc -l < CLAUDE.md` < 30. | bash | Stub goal (dispatch deliverable C). |
| 3 | **No role-heavy markers remain in CLAUDE.md** — `grep -E "telepty inject\|session-layout\|dustcraw 태스크"` returns 0 matches. | bash | Anti-leak content check. |
| 4 | **Installer fresh-install creates correct role file** — run installer against `$AIGENTRY_HOME=$(mktemp -d)`; verify `roles/orchestrator.md` contains the §4.1 marker text (`Hard rule` heading + Rule 16 reference). | bash | Installer §4.4 correctness. |
| 5 | **Installer idempotency** — run installer twice; second run reports "exists file" for `roles/orchestrator.md`; file mtime unchanged. | bash | Article 1 + dispatch deliverable D. |
| 6 | **Installer `--force` overwrites** — pre-populate `roles/orchestrator.md` with sentinel bytes; rerun with `--force`; sentinel replaced; report says "updated file". | bash | New flag. |
| 7 | **No symlinks from layered → CLAUDE.md** — `find ~/.aigentry/instructions -type l -lname '*CLAUDE.md'` empty. | bash | Anti-leak invariant. |
| 8 | **Resolver composes orchestrator effective_prompt with new content** — TS test: call `resolveInstructions({role:"orchestrator", cwd:fixture, task_prompt:"x", task_source_path:"/tmp/t"})` against an `instructions_root` seeded with §4.1 content; assert `effective_prompt` contains the §4.1 `Hard rule` marker AND four `LayerMeta` entries are returned. | TS | End-to-end resolver integration. |
| 9 | **Spawn payload integrity** — TS test: simulate orchestrator-self-spawn via #114 + #104 fixtures; assert `boot_command.prompt_file` content contains §4.1 markers AND does NOT contain telepty `--submit-force` lines that were moved out of CLAUDE.md (they should appear only via the role layer, not via cwd-autoload). | TS | Layer routing correctness. |
| 10 | **Digest stability across migration** — TS test: build `effective_prompt` once from new layered files; build it again; identical sha256. (Regression for #114 determinism contract.) | TS | Determinism preserved. |

Budget: ~120 LOC TS + ~80 LOC bash = ≤200 LOC test total.

---

## 6. Migration log (`state/migration/2026-05-12-claude-md-migration.md`)

Required sections:

1. **Before/after content map** — table mapping each original `CLAUDE.md` line/range → destination (`roles/orchestrator.md` section, `CLAUDE.md` stub, or deleted).
2. **Diff stats** — `CLAUDE.md`: 20 → ~14 lines (-6); `roles/orchestrator.md`: 4 (placeholder) → ~30 lines (+26); installer: ~52 → ~92 LOC (+40).
3. **Pre-migration sha256** — captured at migration start so rollback can verify exact restore.
4. **Rollback procedure** — `git checkout HEAD -- CLAUDE.md bin/install-instructions.sh`; rerun installer with `--force` to restore placeholder `roles/orchestrator.md`; delete `state/migration/2026-05-12-claude-md-migration.md`. Idempotent.

Estimated ≤80 LOC markdown.

---

## 7. LOC budget summary

| File | Status | LOC est. |
|---|---|---|
| `CLAUDE.md` | rewrite | ~14 (was 20) |
| `~/.aigentry/instructions/roles/orchestrator.md` | new content (delivered via installer; not committed) | ~30 |
| `~/.aigentry/instructions/common.md` | unchanged placeholder | 0 |
| `bin/install-instructions.sh` | Δ | +40 / ≤50 |
| `tests/session/orchestrator-migration.test.ts` | new | ~120 |
| `tests/bash/migration-audit.sh` | new | ~80 |
| `state/migration/2026-05-12-claude-md-migration.md` | new | ~80 |

Within Article 1 budget (impl ≤200 LOC; tests ≤200 LOC; installer Δ ≤50 LOC). SPEC self ≤250 lines (this file: ~230).

---

## 8. Constraints & invariants

- TS strict + ESM + node stdlib only (Article 17).
- No symlinks anywhere in `~/.aigentry/instructions/` pointing back to `CLAUDE.md` or `AGENTS.md` — even though #104 is now active, ADR §6 #6 forbids them outright.
- Zero edits to `AGENTS.md`, `GEMINI.md`, `src/session/*`, `tests/session/resolve-instructions.test.ts`, or any #114/#104 source (Rule 29 외과적).
- All existing tests must continue to pass after migration (backwards compat).
- Orchestrator session bootup post-migration must produce an `effective_prompt` containing the §4.1 content (validated by test #8 + #9).

---

## 9. Open questions (orchestrator review required)

1. **`common.md` content?** Audit found 0 common lines in `CLAUDE.md`. Should this SPEC also extract Article-level invariants (Article 1, 17, Rule 29) from `AGENTS.md` into `common.md`, or is that a follow-up task? Dispatch says "touch AGENTS.md only if absolutely necessary"; this SPEC defaults to **no extraction** — leave `common.md` as installer placeholder. Confirm or expand scope.
2. **`CLAUDE-ORCHESTRATOR.md` non-existence.** ADR §6 #6 wording assumed it existed. It does not. SPEC treats `roles/orchestrator.md` as the *new* destination rather than a *migrated* file. Confirm interpretation, or instruct to first create a transitional `CLAUDE-ORCHESTRATOR.md` (would change scope materially).
3. **`GEMINI.md` boundary.** 11 lines of orchestrator-flavored content + `aigentry-orchestrator-gemini` hardcoded session ID (Rule 16 violation). Out of scope this SPEC. Should a follow-up task be filed? If yes, what is the migration target — `roles/orchestrator.md` (same role) or a per-CLI overlay (which doesn't exist in the layer model)?
4. **`@AGENTS.md` placement.** SPEC keeps the Claude-specific `@` reference at the `CLAUDE.md` file level, not in `common.md`. Confirm — or move into `common.md` and rely on resolver+boot-adapter to deliver it.
5. **Pre-migration timing.** #104 boot adapter is "mock-only until upstream CLIs grow the contract" per its commit message. Does ADR §6 #6 want to wait for upstream contract land (#121 / #11), or proceed now given anti-leak invariant is technically satisfied by the mock + the resolver path? SPEC assumes "proceed now"; confirm.

---

## 10. Workflow gate

Per dispatch §Workflow + Rule 24: stop here. Await orchestrator approval before any edits to `CLAUDE.md`, `bin/install-instructions.sh`, or new files under `tests/` / `state/migration/`. REPORT line will be emitted via `telepty inject --ref --submit --submit-retry 2 --from E-coder-mf6-migrate orchestrator ...` per dispatch §Reporting.
