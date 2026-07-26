# Skill Productionization Plan — Mac skill inventory → aigentry version-controlled skillset

- **Task**: #739 (`a739s-skills-plan`)
- **Author**: architect session `a739s-architect`
- **Date**: 2026-07-26
- **Status**: **PLAN ONLY — awaiting orchestrator approval.** No file was moved, deleted, or modified. This document is the only artifact produced.
- **Scope**: classification of every skill on this machine, §17 constitutional review of the third-party layer, SSOT + sync design, distribution path, ordered migration plan.

---

## §0. Executive summary

The dispatch proposed: *orchestrator repo `.agents/skills/` becomes the SSOT, `.claude/skills/` is generated from it, user-global aigentry-ops skills migrate in.*

**This plan refutes that target.** Three independent reasons, each sufficient on its own (§3.1). The decisive one:

> aigentry spawns every subordinate session with `cwd = $HOME/.aigentry/role-sandbox/<role>-<sid>/` (ADR 2026-05-12 cwd-role-decoupling, enforced at `bin/dispatch.sh:465`). That directory is **empty** — verified this session, `ls -la` shows no `.claude`, no `.agents`. Claude Code discovers repo-level skills by cwd. Therefore **skills living in the orchestrator repo reach the orchestrator session and nothing else.** Migrating cross-cutting skills *into* the repo would remove them from every analyst / coder / architect session that uses them today.

The counter-proposal is **two SSOTs split by coupling, not one** — and it is not a new invention: it is what binding ADR `2026-05-05-telepty-devkit-boundary` §3.1 already ruled, plus what ADR `2026-06-06-orchestration-sequence` already implemented for `orchestrate-turn`. The work is to *finish applying* the existing rule, not to pick a new one.

A fourth and fifth skill layer exist that the dispatch inventory did not list: **`aigentry-devkit/skills/` (11 skills, git-tracked, npm-shipped)** and **`aigentry-telepty/skills/` (10 skills, git-tracked)**. Twelve of the 26 "unmanaged user-global" skills are in fact already symlinks or copies of devkit content — they are already productionized. The genuine migration payload is **9 skills**, not 26.

| Bucket | Count | Where they end up |
|---|---|---|
| `aigentry-ops` — genuine payload, unmanaged today | 9 | devkit `skills/` |
| `aigentry-ops` — repo-coupled, already correct | 1 | orchestrator `.agents/skills/` (unchanged) |
| already productionized (devkit-backed, no work) | 12 | unchanged (3 need a drift guard) |
| `personal` — no aigentry coupling | 3 | de-list from devkit `files[]`, keep in git |
| external / sibling-repo owned | 2 | 1 stays, 1 folds into devkit |
| `dead` — delete candidates | 17 | deleted (after a safety commit) |
| `third-party` — reference only, **0 vendored** | 25 | unchanged, + fallback docs |

**Top two risks**: (1) 14 of the 15 repo skills are **git-untracked** — any deletion is unrecoverable, so the plan mandates an "import as-is" commit *before* any delete (§5, Step 1); (2) `clipboard-image` is **Linux-only** (`xclip`, `DISPLAY=:1`) and already ships in the public npm package to Mac and Windows users — a live §17.3 violation found during the scan.

---

## §1. Verified inventory (re-listed 2026-07-26, not trusted from dispatch)

The dispatch named three layers. There are **five**.

| # | Layer | Path | Count | Git | Ships to users? |
|---|---|---|---|---|---|
| L1 | User-global | `~/.claude/skills/` | 26 entries | mixed (see below) | — (destination, not source) |
| L2 | Orchestrator repo | `.agents/skills/` + `.claude/skills/` | 15 (+15 symlinks) | **1 of 15 tracked** | inside the repo clone |
| L3 | Third-party plugins | `~/.claude/plugins/cache/` | 5 families / 25 skills | n/a (vendor) | no |
| **L4** | **devkit repo** | `~/projects/aigentry-devkit/skills/` + `templates/skills/` | **11 + 1** | **12 tracked** | **yes — npm `files[]`** |
| **L5** | **telepty repo** | `~/projects/aigentry-telepty/skills/` | **10** | **10 tracked** | yes — npm |

Plus two sibling-repo skill sources: `~/projects/cmux/skills/` (5, tracked) and `~/projects/claude-workspace-skills/` (1, **not a git repo**).

### L1 decomposed — the 26 entries are not 26 unmanaged skills

| Sub-bucket | Count | Entries |
|---|---|---|
| **symlink → `devkit/skills/`** (dev-mode override; already SSOT'd) | 8 | `auto-multi-llm-review`, `clipboard-image`, `deliberation`, `env-manager`, `orchestrator-response-style`, `telepty-deliberate`, `upsell-trigger`, `youtube-analyzer` |
| **copy of `devkit/skills/`** (byte-identical today — verified by `diff`; drift-prone) | 3 | `deliberation-executor`, `npm-release`, `project-ops` |
| **symlink → `devkit/templates/skills/`** (`SKILL.md` only) | 1 | `propose-next-task` |
| **symlink → sibling repo** | 2 | `cmux` → `~/projects/cmux/skills/cmux`; `workspace-lifecycle` → `~/projects/claude-workspace-skills/` |
| **real local dir — UNMANAGED (the payload)** | 9 | `caveman`, `context-manage`, `deliberation-gate`, `deliberation-test`, `diagnose`, `grill-with-adr`, `sawe`, `session-create`, `work-breakdown` |
| **dead** | 3 | `brain-activate/` (empty dir), `learned/` (empty dir), `dustcraw-task-feed.md` (loose file, no frontmatter — not a skill at all) |

`8 + 3 + 1 + 2 + 9 + 3 = 26` ✓

### L2 decomposed — the repo layer

`.claude/skills/` is **already** a per-skill relative-symlink farm into `.agents/skills/` (`caveman -> ../../.agents/skills/caveman`, ×15). The sync mechanism the dispatch asked us to design **already exists and works**. What is missing is git tracking:

```
git ls-files .agents/skills   →  1 file   (.agents/skills/orchestrate-turn/SKILL.md, mode 100644)
git ls-files .claude/skills   →  1 entry  (.claude/skills/orchestrate-turn,          mode 120000)
git status                    →  14 untracked dirs in .agents/, 14 untracked symlinks in .claude/
```

The 14 untracked skills are `mattpocock/skills` derivatives (attribution blocks present in `caveman`/`diagnose`). Three facts establish they are **not in service**:

1. `AGENTS.md` has **no `## Agent skills` block** — `setup-matt-pocock-skills` was never run on this repo. `to-issues`, `to-prd`, `triage`, `tdd`, `improve-codebase-architecture`, `zoom-out` all state in their own text that they need that block and instruct the reader to run the setup skill first. They are unconfigured.
2. They are **unreachable** from every role-sandboxed session (§0).
3. `grep` across the repo finds **zero** references to any of them outside their own directories — only `orchestrate-turn` is referenced (`AGENTS.md:78`, `docs/adr/2026-06-06-orchestration-sequence.md:37`).

---

## §2. Classification table (goal 1)

Verdict vocabulary per dispatch: `aigentry-ops` / `personal` / `third-party` / `dead`. Every SKILL.md below was read or diffed.

### L1 — user-global (26)

| Skill | Verdict | Target home | Rationale (≤1 line) |
|---|---|---|---|
| `auto-multi-llm-review` | aigentry-ops | devkit (**already**) | Orchestrator blind-spot detector → deliberation MCP; already tracked + shipped. |
| `deliberation` | aigentry-ops | devkit (**already**) | Front door to `aigentry-deliberation` MCP; ADR 2026-05-05 §1.2 already classifies it "devkit — already correct". |
| `deliberation-executor` | aigentry-ops | devkit (**already**, copy) | Turns synthesis into edits; local copy is byte-identical — needs a drift guard, not a migration. |
| `env-manager` | aigentry-ops | devkit (**already**) | direnv layering is install/config territory → ADR rule 3. |
| `orchestrator-response-style` | aigentry-ops | devkit (**already**) | `always_on` orchestrator behavior contract. |
| `telepty-deliberate` | aigentry-ops | devkit (**already**) | Multi-session debate *over* telepty primitives → ADR rule 4 (provisioning over primitives), not telepty itself. |
| `upsell-trigger` | aigentry-ops | devkit (**already**) | Install-profile awareness = devkit's own domain. |
| `propose-next-task` | aigentry-ops | devkit `templates/skills/` (**already**) | Generic idle-turn selector over any `state/task-queue.json`; correctly a template, not repo-coupled. ⚠ Windows gap (§4). |
| `npm-release` | aigentry-ops | devkit (**already**, copy) | Releases the aigentry packages themselves; borderline-generic but earns its keep. |
| `project-ops` | **personal** | devkit git, **drop from `files[]`** | Hardcodes the `dmsdc-ai` GitHub account and its repo list — ships publicly today and is useless-or-confusing to any other user. |
| `clipboard-image` | **personal** | devkit git, **drop from `files[]`** | Generic utility, zero aigentry coupling — and Linux-only (§4 defect). |
| `youtube-analyzer` | **personal** | devkit git, **drop from `files[]`** | `yt-dlp` transcript summarizer; no aigentry coupling. §1 경량 — devkit ships aigentry core. |
| `caveman` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Global copy is a strict superset of the repo copy: adds cross-LLM `[CAVEMAN]` inject tagging + Safe Compact Protocol pairing + REPORT-line format. Cuts orchestrator read-cost on fan-out. |
| `context-manage` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Writes `.context-snapshot.md`, injects to orchestrator via telepty; every session needs it. |
| `deliberation-gate` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Declares `prerequisites.mcp: [aigentry-deliberation]` **and** `fallback: self-criticism` — already §17.4-compliant by construction; belongs beside its siblings. |
| `deliberation-test` | aigentry-ops (**dev-only**) | **devkit git, NOT in `files[]`** | Test harness for the deliberation CLIs — maintainer tooling, not a user capability. |
| `diagnose` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Canonical analyst-role playbook (AGENTS.md role table). Global copy is a superset of the repo copy — see §2.1. |
| `grill-with-adr` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Rule 24 SPEC-FIRST instrument; reads CONSTITUTION + AGENTS.md as canonical glossary. Supersedes repo `grill-me` + `grill-with-docs`. |
| `sawe` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Session autonomous workflow engine — task #130's deliverable, whose own note says "devkit 또는 aigentry-hooks에서 구현". |
| `session-create` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Multi-component provisioning over `open-session.sh` + telepty → ADR rule 4, textbook devkit. |
| `work-breakdown` | **aigentry-ops** | **devkit `skills/` (MIGRATE)** | Reads `telepty list --json` + `task-queue.json` to fan work out; orchestrator-generic, not repo-path-coupled. |
| `cmux` | third-party (sibling) | **unchanged** — `~/projects/cmux/skills/` | Reference doc for cmux's own CLI surface — exact analogue of ADR §3.1 rule 2 (telepty owns `telepty-*` skills). Leave it. |
| `workspace-lifecycle` | aigentry-ops | **devkit `skills/` (MIGRATE, low priority)** | Wraps cmux/aterm primitives into an open→inject→wait→close chain = ADR rule 4. Its current home `~/projects/claude-workspace-skills/` **is not a git repo** — a one-skill orphan directory. |
| `brain-activate` | **dead** | delete | Empty directory. No `SKILL.md`. |
| `learned` | **dead** | delete | Empty directory. No `SKILL.md`. |
| `dustcraw-task-feed.md` | **dead** (as a skill) | delete file; content → AGENTS.md | Loose `.md` with no frontmatter and no directory — Claude Code cannot load it, so it has never fired. Its content is an *orchestration rule* ("when all sessions idle, pull tasks from dustcraw, deliberate before implementing"), which belongs in `AGENTS.md` §4 next to `propose-next-task`, not in a skill. |

### L2 — orchestrator repo (15)

| Skill | Verdict | Target | Rationale |
|---|---|---|---|
| `orchestrate-turn` | **aigentry-ops (repo-coupled)** | **stays** `.agents/skills/` | Invokes `bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh` **by path**. ADR 2026-06-06 §93 locked this and explicitly superseded the "standalone devkit template" idea for it. Already tracked. **Do not move.** |
| `caveman` | **dead** (stale dup) | delete | Older, narrower fork of the global copy (§2.1). |
| `diagnose` | **dead** (stale dup) | delete **after salvage** | Older fork — but holds `scripts/hitl-loop.template.sh`, which the global copy dropped the reference to. Salvage first (§2.1). |
| `grill-me` | **dead** | delete | 635 bytes; fully subsumed by `grill-with-adr`. |
| `grill-with-docs` | **dead** | delete | Generic-project version of `grill-with-adr`, which is the aigentry-aware superset. |
| `handoff` | **dead** | delete | Conversation compaction — `context-manage` (global) does this with the aigentry snapshot protocol. |
| `improve-codebase-architecture` | **dead** | delete | Unconfigured (needs the missing AGENTS.md block), unreachable from sandboxed sessions; the architect role *is* this capability. |
| `prototype` | **dead** | delete | Overlaps `superpowers:brainstorming`; unreachable. |
| `setup-matt-pocock-skills` | **dead** | delete | Installer for the other 12 — pointless once they are gone; never ran anyway. |
| `tdd` | **dead** | delete | `superpowers:test-driven-development` covers it and is maintained upstream. |
| `to-issues` | **dead** | delete | Unconfigured; aigentry tracks work in `state/task-queue.json`, not an issue tracker. |
| `to-prd` | **dead** | delete | Same. |
| `triage` | **dead** | delete | Same. |
| `write-a-skill` | **dead** | delete | Three-way overlap with `superpowers:writing-skills` and the `skill-creator` plugin. |
| `zoom-out` | **dead** | delete | 430 bytes; a prompt, not a skill. |

> **If the user wants any of these 12 kept**, the correct move is *devkit* `skills/`, not the repo — anything left in `.agents/skills/` is invisible to every subordinate session. Keeping them where they are is the one option that does not work.

### L3 — third-party plugins (5 families / 25 skills) → all `third-party`, 0 vendored. See §3.

| Family | Version | License | Skills |
|---|---|---|---|
| `superpowers` (obra/superpowers) | 5.0.1 | MIT | 14 |
| `ponytail` | 4.8.4 | (bundled LICENSE) | 6 |
| `openai-codex` | 1.0.3 | (bundled LICENSE + NOTICE) | 3 |
| `skill-creator` (official) | unknown | — | 1 |
| `claude-md-management` (official) | 1.0.0 | — | 1 |

### §2.1 Duplicate resolution — `caveman` and `diagnose` (dispatch asked: do the copies differ?)

**Yes, both differ, and in both cases the user-global copy is the newer superset.**

`caveman` — global adds, over the repo copy:
- a *Cross-LLM scope* section (`[CAVEMAN]` prefix on telepty injects so the receiving session stays compressed),
- a *Multi-session fan-out leverage* section pairing it with the Safe Compact Protocol and fixing the `REPORT:` line format,
- exact-preservation of file paths / line numbers / commit SHAs (the repo copy only protects code blocks and errors),
- ADR/spec text added to the "drop caveman temporarily" list,
- an MIT attribution block.

`diagnose` — global adds: a *Where this skill fits* routing table (escalate to `superpowers:systematic-debugging`; hand off to architect), the evidence-based-bugfix invariant (no guess patches), the 3-failures→multi-LLM delegation rule, and an attribution block. **But** the repo copy references `scripts/hitl-loop.template.sh` by path and *ships that script*; the global copy genericized the sentence and lost the file.

**Resolution**: take the global body for both. For `diagnose`, copy `scripts/hitl-loop.template.sh` in and restore the by-path reference at step 10. Then delete both repo copies. Net: one canonical version each, no capability lost.

---

## §3. §17 무의존 review of the third-party layer (goal 2)

### §3.1 What §17 actually says

> **제17조** — aigentry 에코시스템은 외부 플러그인이나 라이브러리에 **의존하지 않고** 독립적으로 동작해야 한다.
> 1. 퍼블릭 사용자가 aigentry만 설치하면 **모든 핵심 기능**을 사용할 수 있어야 한다.
> 2. **외부 플러그인(oh-my-claudecode 등)은 선택적 확장이지 필수가 아니다.**
> 3. 특정 에디터, IDE, 터미널, AI CLI에 종속되지 않는다.
> 4. 외부 의존성이 필요한 경우 반드시 **fallback 경로**를 제공한다.

§17.2 answers the dispatch's question directly and in the constitution's own words: an external plugin **is permitted as an optional extension**. The article forbids *depending*, not *using*. So the compliance test is not "is the plugin present?" but:

> **Does any core aigentry capability degrade to unusable when the plugin is absent?** If yes → §17.1 breach, and §17.4 demands a written fallback. If no → compliant, no action.

A second test applies to any *vendoring* proposal: vendoring 25 upstream skills into our repos forks their maintenance forever, which §1 경량 ("no over-engineering", "can we build this without it?") rejects. Vendoring is the **more** expensive answer, not the safe one.

### §3.2 Per-family verdict

| Family | Does aigentry core break without it? | Verdict | Required action |
|---|---|---|---|
| **superpowers** (14, MIT) | No — but two soft references exist: global `diagnose` says "escalate to `superpowers:systematic-debugging`", and this repo has a `docs/superpowers/plans/` directory of plan artifacts. Diagnosis still works standalone; the escalation is an *optional deepening*. | **COMPLIANT as optional. Do NOT vendor.** MIT would permit it, but forking 14 upstream skills for a capability we already have a first-party path to (the diagnose loop + multi-LLM delegation) is exactly the over-engineering §1 forbids. | Add one §17.4 fallback line to `diagnose`: *"if `superpowers:systematic-debugging` is unavailable, continue this loop and delegate cross-LLM per AI 작업 원칙 after 3 failed hypothesis classes."* Rename `docs/superpowers/plans/` → `docs/plans/` (optional, cosmetic — the dir name implies an ownership that does not exist). |
| **ponytail** (6) | No. Pure output-style modifier, nothing reads it, no artifact depends on it. Overlaps our own `caveman` (both are compression modes) but they are independently switchable. | **COMPLIANT. No action.** | None. |
| **openai-codex** (3) | No — and this is the closest call. Our `diagnose` + AI 작업 원칙 route to Codex after 3 failures. **But** aigentry reaches Codex natively via `telepty inject` to a codex session and via `bin/dispatch.sh --cli codex` (see `T47_dispatch_role_codex_gemini.sh`). The plugin is a convenience wrapper over a path we own. | **COMPLIANT as optional. Do NOT vendor.** | Document the native fallback explicitly wherever a doc names the plugin: "Codex delegation = `dispatch.sh --cli codex`; the codex plugin is a convenience only." |
| **skill-creator** (1) | No. Authoring aid. Three-way overlap with `superpowers:writing-skills` and repo `write-a-skill`. | **COMPLIANT. Pick one.** Recommend: delete repo `write-a-skill` (§2), keep both plugins as optional. | None beyond the §2 deletion. |
| **claude-md-management** (1) | No. Authoring aid for `CLAUDE.md`. | **COMPLIANT. No action.** | None. |

### §3.3 Ruling

**No plugin requires vendoring or reimplementation.** All five families are §17.2-compliant optional extensions today. The §17 gap is not *presence* — it is **absence of written fallbacks** for the two capabilities our own docs point at (superpowers escalation, codex delegation). That is a two-line documentation fix, not a migration.

One §17.3 consequence worth stating because it decides §4: **the plugin/marketplace mechanism is Claude-Code-only.** aigentry dispatches to codex and gemini sessions as well. Therefore aigentry must never ship *its own* capability as a Claude Code plugin — that would be the CLI lock-in §17.3 forbids. This independently rules out "publish our skills as a marketplace plugin" as a distribution option (§4).

---

## §4. SSOT + sync design (goal 3)

### §4.1 Refutation of the proposed target

Proposed: repo `.agents/skills/` = single SSOT; user-global aigentry-ops skills migrate in.

**Reason 1 — Reachability (decisive, empirical).**
`bin/dispatch.sh:465` computes a spawn cwd of `$HOME/.aigentry/role-sandbox/<role>-<sid>/` "with no CLAUDE.md → no project auto-discovery contamination" (#431 / ADR 2026-05-12). Verified from inside such a sandbox this session:

```
$ ls -la /Users/duckyoungkim/.aigentry/role-sandbox/architect-a739s-skills-plan/
total 0     # empty — no .claude, no .agents
$ grep -rn "role-sandbox" bin/*.sh | grep -iE "skill|\.claude"
            # nothing seeds skills into the sandbox
```

Claude Code resolves repo-level `.claude/skills/` relative to cwd. So repo skills serve **only the orchestrator session** (which does run in the repo). That is exactly right for `orchestrate-turn` and exactly wrong for `diagnose` (analyst), `grill-with-adr` (architect), `caveman`/`context-manage` (all roles). Executing the proposal would silently delete those capabilities from every subordinate session.

**Reason 2 — A binding ADR already ruled the opposite.**
`docs/adr/2026-05-05-telepty-devkit-boundary.md` is tier-T2, scope-ecosystem, **one-way**. Its §3.1 binding rule (adopted verbatim from the Codex r1 review):

> 2. Telepty may own reference content only when it documents telepty's own CLI/protocol surface.
> 3. **Devkit owns all mutation of user/project files, install profiles, generated templates, and per-AI-CLI integration.**
> 4. Devkit may own session provisioning workflows only when they are multi-component orchestration over telepty primitives.
> *Test of any future artifact: apply rules 1→2→3→4 in order. First match wins.*

Its §1.2 evidence table already classifies `skills/{deliberation,env-manager,deliberation-executor,…}` as **"devkit repo — already correct."** Meanwhile `docs/adr/2026-06-06-orchestration-sequence.md:93` carved the single exception:

> The `orchestrate-turn` skill is **repo-coupled** (it invokes `bin/dispatch.sh`, `bin/session-cleanup.sh`, `bin/tq-*.sh` **by path**) so its source-of-truth lives in THIS repo … **This supersedes an earlier "standalone devkit template + manual symlink" idea (§1 경량 — no duplication).**

The boundary is locked, and it is coupling-based, not location-based. The dispatch's target would reverse a one-way ecosystem ADR without a superseding ADR.

**Reason 3 — Distribution.**
`aigentry-orchestrator` is the operator's private control repo. `@dmsdc-ai/aigentry-devkit` is the published npm package, and its `package.json` `files[]` **already enumerates 11 skill directories plus `templates/skills/**`**. Public users install devkit; they do not clone the orchestrator repo. Cross-cutting skills placed in the orchestrator repo can never reach them → §17.1 breach ("퍼블릭 사용자가 aigentry만 설치하면 모든 핵심 기능을 사용할 수 있어야 한다").

### §4.2 Counter-proposal — route by coupling, two SSOTs

| SSOT | Owns | Reaches | Mechanism |
|---|---|---|---|
| **devkit `skills/`** | cross-cutting skills — every skill that any session role may need | **every session**, via `~/.claude/skills/` | npm `files[]` → `install.sh` `cp -R` / `install.ps1` `Copy-Item` |
| **orchestrator `.agents/skills/`** | **repo-coupled** skills only — those that invoke this repo's `bin/*.sh` by path. Today: exactly `orchestrate-turn`. | orchestrator session only (correct — only it runs `bin/`) | relative symlink → `.claude/skills/`, both committed |
| **telepty `skills/`** | telepty's own CLI reference docs (ADR rule 2) | via telepty install | unchanged |

**Routing test** — apply ADR 2026-05-05 §3.1 rules 1→2→3→4, first match wins, then one skill-specific tiebreak:

> **Does the skill invoke *this repo's* `bin/` (or any repo-relative path) by path?**
> **Yes** → orchestrator `.agents/skills/`.  **No** → devkit `skills/`.

Applied: `orchestrate-turn` → yes → repo. All 9 payload skills → no → devkit. (`work-breakdown` and `propose-next-task` read `state/task-queue.json` **relative to cwd**, generically across any aigentry orchestrator project — not a hardcoded path to *this* repo — so they route to devkit.)

### §4.3 Sync mechanism — evaluated against how Claude Code discovers each directory

| Edge | Mechanism | Verdict |
|---|---|---|
| devkit `skills/` → `~/.claude/skills/` | **copy** (`cp -R`, `Copy-Item -Recurse`) — already implemented at `install.sh:416-434` / `install.ps1:270-276` | **KEEP.** Cross-platform by construction. **Do not switch to symlinks**: Windows symlink creation requires Developer Mode or elevation, and npm pack/publish does not preserve symlinks reliably — either would be a §17.3 platform lock-in. |
| devkit `skills/` → `~/.claude/skills/` **on a maintainer machine** | symlink (already the case for 8 skills) | **KEEP as a dev-only affordance.** It makes edits live. It is *not* the shipped mechanism and must not be documented as one. |
| devkit copies that shadow the source (`deliberation-executor`, `npm-release`, `project-ops`) | none today — byte-identical by luck | **ADD a drift guard.** Recommend `aigentry doctor --skills`: diff each `~/.claude/skills/<n>` against the devkit source, report divergence. Chosen over "just symlink them" because a symlink only helps maintainers, while `doctor` also helps public users detect a stale install. |
| repo `.agents/skills/` → repo `.claude/skills/` | **relative symlink**, already in place, `git ls-files -s` shows mode `120000` for the tracked one | **KEEP.** Git stores symlinks natively; the pair round-trips through clone. Rejected alternatives: `cp` (double-tracks the same bytes → §1), gitignoring `.claude/skills/` (then a fresh clone has no skill and `orchestrate-turn` silently stops firing). |
| **Windows caveat on the repo symlinks** | `core.symlinks=false` on a Windows clone materializes symlinks as plain text files containing the target path | Only affects a Windows clone of the *orchestrator* repo — a maintainer scenario, not a user one. **Note it in AGENTS.md; do not redesign for it.** If it ever bites, the fix is `git config core.symlinks true` + Developer Mode, not a mechanism change. |

### §4.4 Git tracking — what gets committed

| Path | Action |
|---|---|
| `.agents/skills/orchestrate-turn/**` | already tracked — unchanged |
| `.claude/skills/orchestrate-turn` (symlink, mode 120000) | already tracked — unchanged |
| `.agents/skills/{14 others}` + their 14 symlinks | **commit once as-is (safety net), then delete in a second commit** — see §5 Step 1. Untracked deletion is unrecoverable; this is the plan's hardest sequencing constraint. |
| devkit `skills/{9 migrated}/**` | new — commit, and add each to `package.json` `files[]` |
| devkit `skills/deliberation-test/**` | commit to git, **omit from `files[]`** (maintainer tooling) |
| devkit `files[]` entries for `project-ops`, `clipboard-image`, `youtube-analyzer` | **remove** (personal / account-specific) — files stay in git |

---

## §5. Distribution path (goal 4)

### §5.1 The existing route is correct — use it

`@dmsdc-ai/aigentry-devkit@0.0.22` already ships skills:

```
files[]: … "skills/clipboard-image/**", "skills/deliberation/**", "skills/deliberation-executor/**",
          "skills/env-manager/**", "skills/npm-release/**", "skills/project-ops/**",
          "skills/telepty-deliberate/**", "skills/auto-multi-llm-review/**",
          "skills/orchestrator-response-style/**", "skills/upsell-trigger/**",
          "skills/youtube-analyzer/**", "templates/skills/**", …
```

`install.sh:403-435` and `install.ps1:261-276` copy them into `~/.claude/skills/`, idempotently, with `--force`/`-Force` to overwrite. This is the task #130 precedent generalized: devkit propagates content to every machine and every sibling repo (the same route that shipped `bin/snyk-scan.sh` at devkit `9be6de9`). It is already cross-platform, already published, already installed on this machine. **Reaching sibling repos and Linux/Windows nodes requires zero new mechanism — only a `files[]` edit and a version bump.**

### §5.2 Alternatives evaluated and rejected

| Alternative | Verdict |
|---|---|
| Git submodule of a dedicated skills repo | **Reject** — §1 경량. Adds clone-time coupling and a second update ritual; submodules do not reach npm-installed users at all. |
| Separate `@dmsdc-ai/aigentry-skills` package | **Reject for now** — a real option, but ~20 skills does not justify a package boundary, and devkit is already the single install surface. Revisit only if skills ever need a release cadence independent of devkit. |
| Publish our skills as a Claude Code marketplace plugin | **Reject — §17.3.** The plugin mechanism is Claude-Code-only; aigentry dispatches to codex and gemini sessions too. Shipping core capability through a Claude-only channel is the CLI lock-in the constitution forbids. |
| Repo-level `.claude/skills/` in each sibling repo | **Reject** — unreachable from role-sandboxed sessions (§4.1 reason 1). |

### §5.3 Cross-platform / machine-specific defects found (all pre-existing; each independently fixable)

The scan for absolute paths and secrets across all five layers returned:

- **No hardcoded secrets anywhere.** `project-ops` uses `{NEW_TOKEN}` placeholders throughout; the `NPM_TOKEN` hits are variable names and `gh secret set` invocations, not values.
- **No `/Users/...` paths in any `SKILL.md`** in any layer.
- **No macOS-only commands** (`pbpaste`, `osascript`, `screencapture`, `brew`) anywhere.

Four real defects, in severity order:

| # | Defect | Evidence | Severity | Fix |
|---|---|---|---|---|
| D1 | **`clipboard-image` is Linux-only and ships publicly.** Its only capture path is `DISPLAY=:1 xclip -selection clipboard -t image/png -o`; troubleshooting says "try `DISPLAY=:0`". On macOS (no `xclip`, no X server by default) and Windows it silently produces an empty file. | `~/.claude/skills/clipboard-image/SKILL.md` | **§17.3 violation, live in npm** | Branch on platform (`pbpaste`/`osascript` on darwin, `Get-Clipboard` on win32, `xclip`/`wl-paste` on linux), **or** de-list from `files[]` per §2 and add a `prerequisites` + fallback block per §17.4. |
| D2 | **`install.ps1` never installs template skills.** It iterates `skills/` only (line 270); `install.sh` iterates `skills/*/ templates/skills/*/` (line 416). | side-by-side read | Windows users lack `propose-next-task` | Add the `templates/skills` loop to `install.ps1`. |
| D3 | **Author's home path ships in the npm tarball.** `templates/skills/propose-next-task/tests/{refactor-iterations,baseline-no-skill,post-skill-pass}.md` each contain `input_file: /Users/duckyoungkim/projects/aigentry-orchestrator/state/task-queue.json`, and `templates/skills/**` is in `files[]`. | grep | Low (path disclosure, no secret) | Replace with `./state/task-queue.json`, or exclude `tests/` from the packed template. |
| D4 | **`project-ops` ships the `dmsdc-ai` account's operating procedure to the public.** Repo list, account-level assumptions ("개인 계정이므로 repo-level secrets"), and org workflow. | `SKILL.md:25,38-83` | Low-med | De-list from `files[]` (§2), or parameterize the repo list from config. |

---

## §6. Migration plan (goal 5)

Every step is independently shippable and independently revertable. **Steps 1–3 touch the orchestrator repo; steps 4–7 touch devkit; step 8 is documentation.** Nothing below has been executed.

### Step 0 — Land this document
Orchestrator commits `docs/reports/2026-07-26-skill-productionization-plan.md`.
Risk: none. Rollback: `git revert`.

### Step 1 — ⚠ Safety commit BEFORE any deletion (HARD PREREQUISITE)
`git add .agents/skills .claude/skills && git commit -m "chore(skills): import existing .agents/skills as-is before triage (#739)"`
14 skill dirs + 14 symlinks enter history exactly as they are on disk.
**Why this must be first**: those 14 directories are currently untracked. Deleting an untracked file is unrecoverable — no reflog, no revert. This commit converts every subsequent deletion into a `git revert`.
Risk: none (pure addition). Rollback: `git reset`.

### Step 2 — Salvage, then delete the 2 stale duplicates
1. Copy `.agents/skills/diagnose/scripts/hitl-loop.template.sh` into the canonical `diagnose` skill.
2. Restore the by-path reference at diagnose step 10 (the global copy genericized it — §2.1).
3. Delete `.agents/skills/{caveman,diagnose}` and their two symlinks.
Risk: silently losing the HITL script. Mitigation: salvage is steps 1–2, delete is step 3, in that order, one commit. Rollback: `git revert`.

### Step 3 — Delete the 12 unused mattpocock skills
`grill-me`, `grill-with-docs`, `handoff`, `improve-codebase-architecture`, `prototype`, `setup-matt-pocock-skills`, `tdd`, `to-issues`, `to-prd`, `triage`, `write-a-skill`, `zoom-out` + their symlinks.
Justification restated: unreachable from sandboxed sessions, unconfigured (no `## Agent skills` block in AGENTS.md), zero inbound references, superseded by plugins or by `grill-with-adr`.
Risk: a skill was actually in use by the orchestrator session and no one noticed. Mitigation: Step 1's commit; also cheap to verify first — `grep -rn "<name>" AGENTS.md CLAUDE.md docs/ bin/` returned nothing for all 12.
Rollback: `git revert`.
**After steps 2+3 the repo holds exactly one skill: `orchestrate-turn`.** That is the intended end state.

### Step 4 — Promote the 9 payload skills into devkit
`caveman`, `context-manage`, `deliberation-gate`, `deliberation-test`, `diagnose`, `grill-with-adr`, `sawe`, `session-create`, `work-breakdown` → `~/projects/aigentry-devkit/skills/`.
Per skill: `git add` in devkit → add `"skills/<n>/**"` to `files[]` (**except `deliberation-test`**, maintainer-only) → on this machine replace `~/.claude/skills/<n>` with a symlink to the devkit source, matching the existing 8.
Risk: a broken symlink silently removes a skill from every session. Mitigation: after each, verify `test -f ~/.claude/skills/<n>/SKILL.md`; keep the original directory as `<n>.bak` until the whole step verifies, then remove the `.bak`s in a follow-up.
Rollback: `rm` the symlink, `mv <n>.bak <n>`.
Sequencing note: independent of steps 1–3 — can ship first or in parallel. Shipping it *before* step 3 is slightly safer (capabilities land before anything is removed).

### Step 5 — Fold in `workspace-lifecycle` (low priority)
Move `~/projects/claude-workspace-skills/workspace-lifecycle` into devkit `skills/`; retire the orphan directory (it is not a git repo — its content exists nowhere else).
Risk: it is the only copy. Mitigation: `git add` in devkit **before** removing the original.
Rollback: restore from devkit git.

### Step 6 — Fix the four cross-platform defects (D1–D4, §5.3)
Fully independent of every other step; ship any time, in any order. Each is a small, isolated diff.
Risk: D1's platform branch is the only one with real behavior change — needs a smoke test per platform, or ship the de-list variant (§2) which is risk-free.
Rollback: `git revert` per fix.

### Step 7 — Drift guard: `aigentry doctor --skills`
Compare each installed `~/.claude/skills/<n>` against the devkit source; report copies that diverged (the `deliberation-executor` / `npm-release` / `project-ops` class). Read-only.
Risk: none. Rollback: `git revert`.

### Step 8 — Write the routing rule down
1. `AGENTS.md`: one line — *"`.agents/skills/` holds ONLY repo-coupled skills (those that invoke `bin/` by path). Everything cross-cutting lives in devkit `skills/` and reaches sessions via `~/.claude/skills/`, because role-sandboxed sessions cannot see repo-level skills (ADR 2026-05-12)."*
2. `AGENTS.md` §4: absorb the `dustcraw-task-feed.md` orchestration rule, then delete the loose file.
3. Delete the two empty directories `~/.claude/skills/{brain-activate,learned}`.
4. Add the two §17.4 fallback lines from §3.2 (superpowers escalation; codex delegation).
5. **Recommended**: author `docs/adr/2026-07-XX-skill-ownership-routing.md`. This is a one-way, ecosystem-scope boundary decision of the same class as ADR 2026-05-05 — it deserves an ADR, not just a report. It would *extend* 2026-05-05 §3.1 with the reachability constraint and the repo-coupling tiebreak, superseding nothing.

### §6.1 Step dependency graph

```
Step 0 (land doc)
   └─ Step 1 (safety commit)  ── HARD GATE for steps 2, 3
         ├─ Step 2 (salvage + delete 2 dups)
         └─ Step 3 (delete 12)          ← prefer to run after Step 4
Step 4 (promote 9 → devkit)   ── independent; safest to run before Step 3
   └─ Step 5 (fold workspace-lifecycle)
Step 6 (D1–D4 fixes)          ── fully independent
Step 7 (doctor --skills)      ── after Step 4
Step 8 (docs + ADR)           ── last
```

---

## §7. Open decisions for the orchestrator

Four judgment calls that change the work and are the user's to make, not mine. Recommendation given for each; none blocks starting Step 0/1/4.

1. **Delete all 12 mattpocock skills, or keep some?** Recommend delete all. If any is wanted, it must move to devkit (repo = invisible to sessions). *(§2, Step 3)*
2. **`personal` skills — de-list `project-ops` / `clipboard-image` / `youtube-analyzer` from the public npm package?** Recommend yes: keep in devkit git, drop from `files[]`. §1 경량 — devkit ships aigentry core, not the maintainer's utility belt. *(§2, §5.3 D1/D4)*
3. **Write the ADR (Step 8.5), or is this report enough?** Recommend the ADR — it is a one-way ecosystem boundary call, same tier as 2026-05-05, and future sessions will re-litigate it from a report but not from an ADR.
4. **`workspace-lifecycle` — fold into devkit now or leave the orphan directory?** Recommend fold (Step 5); it is currently the only copy of that content, stored outside version control.

---

## §8. Verification log

Every claim above traces to a command run in this session, from the sandbox cwd, read-only.

| Claim | Verification |
|---|---|
| L1 = 26 entries, 10 top-level symlinks + 1 nested symlink | `ls -1 ~/.claude/skills/`; `ls -l ~/.claude/skills/ \| grep ^l`; `find <dir> -type l` |
| `brain-activate`, `learned` empty | `ls -la` → `total 0` |
| `.claude/skills/` is a relative-symlink farm into `.agents/skills/` | `ls -l .claude/skills/` → 15× `-> ../../.agents/skills/<n>` |
| 1 of 15 repo skills tracked; modes 100644 / 120000 | `git ls-files -s .agents/skills .claude/skills`; `git status --porcelain` |
| `caveman`, `diagnose`: global ⊃ repo | `diff` both pairs (§2.1) |
| `deliberation-executor`, `npm-release`, `project-ops`: byte-identical to devkit | `diff -q` ×3 |
| devkit ships 11 skills + `templates/skills/**` via npm | `package.json` `files[]` |
| devkit installs by copy, both platforms | `install.sh:403-435`; `install.ps1:261-276` |
| `install.ps1` omits `templates/skills` | line 270 vs `install.sh:416` |
| role-sandbox cwd is empty; nothing seeds skills into it | `ls -la <sandbox>`; `grep -rn role-sandbox bin/*.sh \| grep -iE "skill\|\.claude"` → ∅ |
| sandbox cwd is computed by dispatch | `bin/dispatch.sh:462-470` |
| binding boundary rule | `docs/adr/2026-05-05-telepty-devkit-boundary.md` §1.2, §3.1 (4 rules), §3.4 |
| `orchestrate-turn` repo-coupling ruling | `docs/adr/2026-06-06-orchestration-sequence.md:37,93`; `AGENTS.md:78` |
| §17 text | `~/projects/aigentry/docs/CONSTITUTION.md` 제17조 |
| plugin versions / licenses / skill counts | `.claude-plugin/plugin.json` ×5; `ls skills/` ×5 |
| L5 telepty layer = 10 tracked skills | `ls ~/projects/aigentry-telepty/skills/`; `git ls-files skills \| wc -l` |
| `claude-workspace-skills` is not a git repo | `git remote -v` → ∅ |
| no secrets, no `/Users/` in any `SKILL.md`, no macOS-only commands | 3 recursive greps across all five layers |
| `/Users/duckyoungkim/...` in packed template test fixtures | `grep -rn "/Users/" devkit/templates/skills/` → 3 hits |
| no AGENTS.md `## Agent skills` block | `grep -i -A12 "agent skills" AGENTS.md` → ∅ |
| the 12 have zero inbound references | `grep -rn` across `*.md *.sh *.js` excluding their own dirs |

**Not verified / explicitly out of scope**: no skill was executed; no claim is made about runtime correctness of any skill body beyond the platform defects in §5.3. Whether Claude Code would resolve a repo-level skill through some mechanism other than cwd was not exhaustively tested — the empirical evidence is that this architect session, dispatched into an empty sandbox, has none of the 15 repo skills available while it does have the user-global ones.
