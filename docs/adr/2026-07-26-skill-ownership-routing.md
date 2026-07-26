---
type: adr
status: accepted
scope: ecosystem
decision_type: one-way
tier: T2
revision: r4
previous_revision: f8ea49a
accepted_at: 2026-07-26
date: 2026-07-26
author: aigentry-architect-claude (a739s-architect)
acceptance_basis: "Decision content approved in full by the user 2026-07-26 (all 4 open decisions per architect recommendation, on report docs/reports/2026-07-26-skill-productionization-plan.md). T2 reviewer threshold (2) SATISFIED on r3: reviewer 2 (gemini-family) r1 REQUEST_CHANGES (B1-B3) → resolved in r2 → r2 ACCEPT (all resolved, no new contradictions, arithmetic recomputed correct); reviewer 1 (codex) r2 REQUEST_CHANGES (2 blocking, non-overlapping) → resolved in r3 → r2 ACCEPT with one non-blocking §1.3 wording note, applied in r4. Cumulative: 3+2 blocking + 5 non-blocking = ALL RESOLVED. See §9 Q1."
r4_basis: "Reviewer 1 (codex) r3 ACCEPT, one non-blocking note only: §1.3's SANDBOX-REACH invariant still said 'every subordinate session can reach only ~/.claude/skills/', a pre-r3 remnant not reflecting the narrowed Claude-Code scope. Scoped to 'every subordinate Claude Code session' with a pointer to the §2 per-CLI reach table. Status flipped proposed → accepted; §9 Q1 review-state table and acceptance_basis updated to match. No ruling, alternative, verdict, score, metric, or migration step changed in r4."
r3_basis: "Reviewer 1 (codex) round-2 REQUEST_CHANGES — 2 blocking (non-overlapping with round 1; its N1 duplicates the already-fixed r2 B1 arithmetic and independently confirms the same 5 corrected figures) + 3 non-blocking. B1 deliberation-test shipped-vs-maintainer-only contradiction (§2 corollary 5 said not-packed; §6 and §8 M1 claimed 9/9 installable) — RESOLVED IN FAVOUR OF SHIPPING: the carve-out cost a permanent exception plus SKILLS_DELISTED bookkeeping to save 2.4KB of markdown, §1 경량 favours one rule with no exception, and it matches npm-pack-verified shipped reality (feat/739-skills-promotion @ 42fab3a, all 10 in files[]); the 3 personal de-listings are unaffected (excluded for account-specificity/platform breakage, a different and surviving reason); new defect D5 recorded (deliberation-test trigger '테스트 돌려' is misfire-prone). B2 'devkit reaches EVERY session' is false for codex/gemini (codex reads $CODEX_HOME/skills/ preserved through the shadow home per boot-adapter/codex.ts:23-24; gemini has no skill mechanism) while §17.3 leaned on codex/gemini parity — RESOLVED BY NARROWING: ADR explicitly scoped to Claude Code skill distribution, per-CLI reach table added to §2, and the §17.3 corollary re-grounded on CHANNEL portability (a marketplace plugin can never gain a codex destination; devkit's installer can — one loop, format already compatible) rather than on present parity; codex gap carried as new §9 Q5 with gemini's different-mechanism half deferred to a follow-up ADR. N2 'sandbox is empty' narrowed to 'no .claude/.agents skill tree is seeded into any role sandbox' (a codex/gemini sandbox is NOT empty post-#532). N3 'zero new mechanism' qualified — doctor --skills and any Q5 codex loop are optional post-migration hardening, not decision prerequisites. UNCHANGED in r3: routing rule + tiebreak, three-SSOT split, all 4 alternative rejections, all 5 constitution verdicts, every §5 score."
r2_basis: "Reviewer 2 (gemini-family) round-1 REQUEST_CHANGES — 3 blocking + 2 non-blocking. B1 trade-off totals arithmetic wrong in 4/5 columns (independently re-derived and corrected; no score changed, ranking unchanged). B2 §8.1 dependency notation permitted deletions before promotion, contradicting the ADR's own CAPABILITY-BEFORE-REMOVAL invariant (graph and prose corrected; 4→2 identified as a hard data dependency, not a preference). B3 step-1 row omitted skills-lock.json (now recorded as complete per f8ea49a). Non-blocking: §1.3 line citations re-verified against HEAD and corrected to boot-prepare.mjs:493-499/648 + dispatch.sh:511-517/528-533/557. Non-blocking §17.4 scope note — reviewer accepted rationale, no change. No ruling, alternative, or constitution verdict changed in r2."
tags: [skills, boundary, devkit, telepty, role-separation, article-3, article-17, cwd-decoupling, ssot]
supersedes: []
extends:
  - "docs/adr/2026-05-05-telepty-devkit-boundary.md (§3.1 binding 4-rule ownership test)"
  - "docs/adr/2026-06-06-orchestration-sequence.md (§93 orchestrate-turn repo-coupling exception)"
related:
  - "docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md"
  - "docs/reports/2026-07-26-skill-productionization-plan.md"
  - "~/projects/aigentry/docs/CONSTITUTION.md (제1조 경량, 제2조 크로스, 제3조 컴포넌트 역할, 제17조 무의존)"
related_tasks: [739, 130, 431]
unblocks:
  - "#739 step 4 — promote 9 unmanaged skills into devkit skills/"
  - "#739 step 3 — delete 12 unused mattpocock skills from .agents/skills/"
  - "#739 step 6 — cross-platform skill distribution defects D1-D4"
---

# ADR 2026-07-26 — Skill Ownership Routing: two SSOTs split by coupling, not by location

## §1 Context

Skills on this machine had accreted across **five** layers with no ownership rule, most of them
outside version control. Task #739 asked for a single version-controlled skillset, and proposed
consolidating everything into the orchestrator repo's `.agents/skills/`.

Analysis (`docs/reports/2026-07-26-skill-productionization-plan.md`) established that the proposed
target is **not merely suboptimal but actively destructive**: it would remove capabilities from every
session that uses them. This ADR locks the routing rule that replaces it, so the question is not
re-litigated per-skill.

The decision is **one-way** in the Bezos sense: skill homes determine which npm package ships them,
which install path materializes them, and which sessions can see them. Reversing means moving files
across repos, rewriting `package.json` `files[]`, and re-cutting releases that downstream machines
have already installed.

### §1.1 Evidence

- **[REF: user-request / task-#739]** — "Mac 전체 스킬 인벤토리를 aigentry 오케스트레이터 스킬셋으로
  프로덕션화 (SSOT 수렴 + repo 버전관리 + 배포 경로)". User approved this ADR's decision content in
  full on 2026-07-26.
- **[REF: architect-report 2026-07-26]** — `docs/reports/2026-07-26-skill-productionization-plan.md`,
  §8 verification log: every claim below traced to a command run read-only from a role sandbox.
- **[REF: ADR 2026-05-05-telepty-devkit-boundary §3.1]** — the binding 4-rule ownership test this ADR
  extends rather than replaces.
- **[REF: ADR 2026-05-12 / task-#431]** — cwd-role decoupling; the mechanism that produces the
  unreachability constraint in §1.3.

### §1.2 기존 메커니즘 대조 (재구현 회피)

Nothing in this ADR builds new machinery. Every mechanism it depends on already exists and is in
production:

| Capability | Already exists | Location |
|---|:-:|---|
| Cross-cutting skill SSOT, git-tracked | **YES** | `~/projects/aigentry-devkit/skills/` — 11 skills, 12 files tracked |
| Skill distribution to any machine (npm) | **YES** | devkit `package.json` `files[]` — already enumerates 11 skill dirs + `templates/skills/**` |
| Install into `~/.claude/skills/`, POSIX | **YES** | `install.sh:403-435` (`cp -R`, idempotent, `--force`) |
| Install into `~/.claude/skills/`, Windows | **YES (partial)** | `install.ps1:261-276` (`Copy-Item -Recurse`) — misses `templates/skills/`, see §7.2 D2 |
| Repo-coupled skill SSOT + surfacing | **YES** | `.agents/skills/orchestrate-turn/` + relative symlink `.claude/skills/orchestrate-turn` (git mode `120000`) |
| telepty CLI reference skills | **YES** | `~/projects/aigentry-telepty/skills/` — 10 skills, all tracked |
| Ownership test for a new artifact | **YES** | ADR 2026-05-05 §3.1 rules 1→2→3→4, first match wins |
| Upstream provenance record for vendored skills | **YES** (committed `f8ea49a`) | `skills-lock.json` at repo root — `{source, sourceType, skillPath, computedHash}` per skill |
| **Routing tiebreak for skills specifically** | **NO** | ← the only gap this ADR fills |
| **Written §17.4 fallbacks for referenced plugins** | **NO** | ← second gap this ADR fills |

The gap is one sentence of routing rule and two sentences of fallback documentation. **The routing
decision itself requires no new script, no new package, and no new sync mechanism.**

**(r3) Qualification.** Two items in the migration *are* new devkit behavior and must not hide behind
that claim: `aigentry doctor --skills` (§8.1 step 7) and, if §9 Q5 is taken up, a codex destination
loop in `install.sh`. Both are **optional post-migration hardening** — steps 1-6 deliver the decision
in full without either. The "no new mechanism" claim is scoped to the ownership/routing decision and
its delivery path, not to every follow-up the ADR recommends.

### §1.3 The decisive constraint — role-sandbox unreachability

Every subordinate session is spawned into a per-session sandbox cwd (#431, enforcing ADR 2026-05-12).
Citations re-verified against HEAD on 2026-07-26 (r2):

| What | Where |
|---|---|
| Sandbox path **computed** — `join(homedir(), ".aigentry", "role-sandbox", …)` | `bin/boot-prepare.mjs:493-499` |
| Returned to the caller as `spawn_cwd` | `bin/boot-prepare.mjs:648` |
| Boot-wiring intent (the comment quoted below) | `bin/dispatch.sh:511-517` |
| `boot-prepare.mjs` invoked; `spawn_cwd` extracted into `boot_spawn_cwd` | `bin/dispatch.sh:528-533` |
| Handed to the terminal adaptor as the spawn cwd | `bin/dispatch.sh:557` (`--cwd "$boot_spawn_cwd"`) |

> "Compute a sandbox spawn cwd (`$HOME/.aigentry/role-sandbox/<role>-<sid>/`) with no CLAUDE.md →
> no project auto-discovery contamination"
> — `bin/dispatch.sh:512-513`

Verified 2026-07-26 from inside such a sandbox (the **Claude** architect session that authored this ADR):

```
$ ls -la $HOME/.aigentry/role-sandbox/architect-a739s-skills-plan/
total 0                      # no .claude/ or .agents/ skill root
$ grep -rn "role-sandbox" bin/*.sh bin/lib/*.sh | grep -iE "skill|\.claude"
                             # ∅ — nothing seeds a skill tree into the sandbox
```

**(r3) Precision on "empty".** A *Claude* role sandbox is literally empty, because the role prompt is
delivered by `--append-system-prompt-file` and nothing is written into cwd. A **codex or gemini**
sandbox is **not** empty post-#532: `boot-prepare.mjs:562-599` stages `AGENTS.md`/`GEMINI.md` into cwd
and builds a `.codexhome`/`.geminihome` shadow config home. The load-bearing claim is therefore not
"the sandbox is empty" but the narrower, still-decisive:

> **No role sandbox, for any CLI, receives a `.claude/skills/` or `.agents/skills/` tree.** No code
> path seeds one. Repo-level skills reach the orchestrator session and nothing else.

That narrower statement is what SANDBOX-REACH rests on, and it is unaffected by #532's cwd staging.

Claude Code resolves repo-level `.claude/skills/` **relative to cwd**. The sandbox is deliberately
clean — that is the entire point of #431. Therefore:

> **INVARIANT (SANDBOX-REACH):** a skill placed in any repo's `.claude/skills/` is visible **only** to a
> session whose cwd is that repo. Under #431 that is the orchestrator session and no other. Every
> subordinate **Claude Code** session (analyst / coder / architect / …) can reach **only**
> `~/.claude/skills/`. *(Subordinate codex / gemini sessions reach neither — they read
> `$CODEX_HOME/skills/` or have no skill mechanism at all; see the §2 per-CLI reach table.)*

This is not a defect to fix. Sandbox cleanliness is a deliberate, ADR-locked property. It is a
**constraint to route around**, and it is what makes "consolidate into the repo" the one option that
cannot work.

### §1.4 Inventory at decision time (verified, not assumed)

| Layer | Path | Count | Tracked |
|---|---|---|---|
| L1 user-global | `~/.claude/skills/` | 26 entries | destination, not a source |
| L2 orchestrator repo | `.agents/skills/` (+ 15 symlinks in `.claude/skills/`) | 15 | 1 of 15 at analysis time |
| L3 third-party plugins | `~/.claude/plugins/cache/` | 5 families / 25 skills | vendor |
| L4 **devkit** | `~/projects/aigentry-devkit/skills/` + `templates/skills/` | 11 + 1 | 12 — **npm-shipped** |
| L5 **telepty** | `~/projects/aigentry-telepty/skills/` | 10 | 10 |

L4 and L5 were absent from the task brief. Their existence is why the genuine migration payload is
**9 skills, not 26**: 12 of the 26 L1 entries are already devkit-backed (8 dev-mode symlinks, 3
byte-identical copies, 1 template symlink).

---

## §2 Decision

**Skill ownership routes by *coupling*, never by location or convenience. Three SSOTs, one test.**

**Scope (r3).** This ADR governs **Claude Code** skill ownership and distribution. Cross-CLI skill
delivery (codex, gemini) is **explicitly out of scope** and carried as §9 Q5 — see the reach table
below for why, and §4.3 for why that does not weaken the §17.3 corollary.

| SSOT | Owns | Reaches | Delivery mechanism |
|---|---|---|---|
| **devkit `skills/`** | every **cross-cutting** skill — any skill a session of any role may need | **every Claude Code session**, via `~/.claude/skills/` (see per-CLI reach table below) | npm `files[]` → `install.sh` `cp -R` / `install.ps1` `Copy-Item` |
| **orchestrator `.agents/skills/`** | **repo-coupled** skills only — those invoking *this repo's* `bin/` by path. Today: exactly `orchestrate-turn`. | orchestrator session only — which is correct, since only it runs `bin/` | relative symlink into `.claude/skills/`; both committed |
| **telepty `skills/`** | reference docs for telepty's own CLI/protocol surface | telepty install | unchanged (ADR 2026-05-05 §3.1 rule 2) |

**Per-CLI reach — what "reaches every session" does and does not mean (r3, verified).** r1 asserted
devkit reaches *every* session. That is false for non-Claude workers, and the correction matters
because §4.3 leans on codex/gemini being first-class:

| Worker CLI | Skill home it actually reads | devkit install writes there? | Status |
|---|---|:-:|---|
| **claude** | `~/.claude/skills/` | **YES** — `install.sh:416-434`, `install.ps1:270-276` | reached |
| **codex** | `$CODEX_HOME/skills/` (shadow-mirrored from `~/.codex/skills/`) | **NO** | **gap → §9 Q5** |
| **gemini** | *none* — gemini has no skill mechanism; role context arrives as a cwd `GEMINI.md` | **N/A** | not applicable |

Evidence: `src/session/boot-adapter/codex.ts:23-24` — the shadow home symlink-preserves "everything
else — `auth.json`, `config.toml`, **`skills/`**"; `bin/boot-prepare.mjs:562-599` builds that shadow
home and redirects `CODEX_HOME`/`GEMINI_CLI_HOME`; `~/.gemini/` contains no `skills/` directory.

**The codex gap is a destination gap, not a format gap.** `~/.codex/skills/<n>/SKILL.md` uses the same
`name:` + `description:` frontmatter shape as a Claude skill (verified against
`~/.codex/skills/frontend-skill/SKILL.md`), so closing it is one additional destination loop in
`install.sh` — not a redesign. It is deferred rather than done here because gemini needs a genuinely
different mechanism (context-file, not skill-dir), and designing that belongs in its own ADR.

**The routing test** — apply ADR 2026-05-05 §3.1 rules 1→2→3→4, first match wins; then this ADR's
skill-specific tiebreak:

> **Does the skill invoke *this repo's* `bin/` (or any repo-relative path) by path?**
> **YES** → orchestrator `.agents/skills/`.  **NO** → devkit `skills/`.

Two clarifications the tiebreak needs to survive contact:

- *"this repo's"* is literal. `work-breakdown` and `propose-next-task` read `state/task-queue.json`
  **relative to cwd**, generically across any aigentry orchestrator project — that is genericity, not
  coupling. They route to devkit.
- A skill that is half-coupled is **decomposable** — split it, per ADR 2026-05-05 §3.1's own closing
  instruction ("If two rules match, the artifact is decomposable — split it").

**Corollary rulings adopted with this decision:**

1. **Sync stays as-is.** repo `.agents/` → `.claude/skills/` = **relative symlinks, committed** (git
   mode `120000`). devkit → `~/.claude/skills/` = **copy**. Neither is replaced. No new sync script.
2. **Copy, not symlink, for distribution.** Windows symlink creation requires Developer Mode or
   elevation, and npm pack/publish does not preserve symlinks reliably. Maintainer-machine symlinks
   into devkit remain a **dev-only affordance**, never documented as the shipped mechanism.
3. **§17.3 no-plugin-distribution corollary** — see §4 Q3 / §4.3.
4. **§17.4 written-fallback obligation** — see §4.3.
5. `personal` skills (no aigentry coupling, or account-specific) stay in devkit git but are **removed
   from `files[]`**: `project-ops`, `clipboard-image`, `youtube-analyzer`.
   **(r3) All 9 promoted skills ship, `deliberation-test` included.** r1 carved it out as
   "maintainer-only tooling — git-tracked, not packed", which contradicted §6 and §8 M1's 9/9 claims.
   Resolved **in favour of shipping**, on the merits rather than on convenience:
   - The carve-out cost more than it saved. It buys nothing measurable — the skill is ~2.4 KB of
     markdown — while costing a permanent exception to an otherwise uniform rule, a `SKILLS_DELISTED`
     bookkeeping entry, and (as reviewer 1 found) an internal contradiction that survived a full
     review round. **§1 경량 cuts toward one rule with no exception**, not toward a special case.
   - "Maintainer-only" was also the weaker classification: a user running deliberation has a
     legitimate reason to smoke-test their own deliberation setup.
   - It matches shipped, `npm pack`-verified reality (`feat/739-skills-promotion` @ `42fab3a`), so it
     needs **zero devkit change**; the alternative would require a `files[]` revert.
   - The three `personal` de-listings above are unaffected and remain correct — they are excluded for
     *account-specificity and platform breakage*, which is a different reason than "maintainer-only"
     and survives this reversal.
   - **Caveat recorded as D5 (§4 Q4)**: `deliberation-test`'s trigger list includes `"테스트 돌려"`
     ("run the tests"), generic enough to misfire for a user who just wants their test suite run. That
     is a skill-content defect to fix by tightening triggers — **not** a reason to withhold the skill.

---

## §3 Alternatives Considered

### §3.1 Alternative A — Single SSOT in the orchestrator repo (the task brief's proposal)

- **Description**: `.agents/skills/` becomes the one SSOT; `.claude/skills/` generated from it; all
  user-global aigentry-ops skills migrate in; distribution rides the repo clone.
- **Pros**: one location, conceptually simple; reuses the symlink farm already present; puts skills
  next to the `bin/` scripts and ADRs that describe them.
- **Cons / rejection** — three independent disqualifiers, each sufficient alone:
  1. **Violates SANDBOX-REACH (§1.3).** Executing it would delete `diagnose` from analyst sessions,
     `grill-with-adr` from architect sessions, and `caveman`/`context-manage` from all of them. The
     proposal's central action is a capability regression, silently.
  2. **Reverses a one-way ecosystem ADR without superseding it.** ADR 2026-05-05 §3.1 rule 3 gives
     devkit all user/project-file mutation and per-CLI integration; its §1.2 evidence table already
     records `skills/{deliberation,env-manager,deliberation-executor,…}` as "devkit — **already
     correct**".
  3. **Breaks §17.1.** The orchestrator repo is the operator's private control repo; devkit is the
     published npm package. Skills placed in the repo can never reach a public user, so
     "퍼블릭 사용자가 aigentry만 설치하면 모든 핵심 기능을 사용할 수 있어야 한다" fails.

### §3.2 Alternative B — A dedicated `@dmsdc-ai/aigentry-skills` package

- **Description**: extract all cross-cutting skills into their own npm package with its own release
  cadence; devkit depends on it or installs it alongside.
- **Pros**: skills version independently of devkit; a clean conceptual boundary; a plausible end state
  if the skill count grows an order of magnitude.
- **Cons / rejection**: **§1 경량 — premature.** ~20 skills does not justify a package boundary. It
  adds a second release ritual, a second version to keep in lockstep, and a dependency edge, to solve
  a coupling problem that does not exist yet (no skill has ever needed to ship without devkit).
  devkit is already the single install surface. **Revisit only if skills ever require a release
  cadence genuinely independent of devkit** — that trigger is recorded in §9 Q3.

### §3.3 Alternative C — Publish aigentry skills as a Claude Code marketplace plugin

- **Description**: package our skills the way superpowers/ponytail are packaged; users install from a
  marketplace.
- **Pros**: idiomatic for Claude Code; free update mechanism; discoverability.
- **Cons / rejection**: **§17.3 violation, decisive.** The plugin/marketplace **distribution channel**
  is structurally Claude-Code-only — a codex or gemini destination cannot be added to it at any price.
  aigentry dispatches codex and gemini as first-class session CLIs
  (`bin/dispatch.sh --cli {claude,codex,gemini}`, `tests/dispatch/T47_dispatch_role_codex_gemini.sh`),
  so committing core capability to a channel that can never serve them is the AI-CLI lock-in the
  constitution forbids. **(r3)** The chosen devkit installer is Claude-only in its *current
  destinations* too (§2 per-CLI reach table) — but that is a wiring gap it can close (§9 Q5), whereas
  the plugin channel forecloses the option permanently. That channel-vs-destination distinction is
  what makes this rejection hold; it generalizes into the standing corollary in §4.3.

### §3.4 Alternative D — Git submodule of a shared skills repo, checked out per consumer repo

- **Description**: one skills repo, added as a submodule wherever skills are needed.
- **Pros**: single history; explicit pinning.
- **Cons / rejection**: **§1 경량** — adds clone-time coupling and a second update ritual; and it does
  not reach npm-installed users **at all**, who never clone anything. Fails the same §17.1 test as
  Alternative A.

### §3.5 Chosen — Two SSOTs split by coupling (§2)

- **Description**: devkit owns cross-cutting; the orchestrator repo owns only what is bound to its own
  `bin/`; telepty owns its own CLI docs. One tiebreak question routes any future skill.
- **Selection rationale**: it is the only option satisfying SANDBOX-REACH **and** §17.1 **and** the
  existing one-way boundary ADR simultaneously. It requires zero new mechanism — every part is already
  in production (§1.2). It is not a new rule so much as the completion of a rule locked on 2026-05-05
  and already applied once, correctly, on 2026-06-06.

---

## §4 Constitution Check

### Q1: AI 기술 격차 해소에 복무하는가? — **PASS**

Cross-cutting skills reach public users through `npm i -g @dmsdc-ai/aigentry-devkit` with no manual
file placement, no repo clone, and no per-machine symlink ritual; Alternative A would have made them
unreachable to anyone who is not the repo operator.

### Q2: 이 기능은 어느 컴포넌트의 역할인가? — **PASS**

The ADR assigns nothing new. It applies ADR 2026-05-05 §3.1 (devkit = disk-side content + per-CLI
integration; telepty = its own protocol surface) and preserves the single carved exception from ADR
2026-06-06 (`orchestrate-turn` is repo-coupled because it invokes `bin/*.sh` by path). No component
gains a responsibility it did not already hold. 제3조 침범 없음.

### Q3: 이 프레임워크/라이브러리가 정말 필요한가? — **PASS** (제1조 + 제17조)

**Zero new dependencies; no new code required by the decision itself** (`doctor --skills` and any Q5
codex loop are optional hardening — §1.2 r3 qualification). Distribution = the existing `files[]` + `cp -R`/`Copy-Item`
already in `install.sh`/`install.ps1`. Sync = the symlink farm already committed. Three heavier
alternatives (separate package §3.2, marketplace plugin §3.3, submodule §3.4) were rejected
specifically on 제1조 경량 grounds.

**Third-party plugin review (제17조 무의존), per family.** §17.2 answers the question in the
constitution's own words — *"외부 플러그인(oh-my-claudecode 등)은 **선택적 확장이지 필수가 아니다**"*.
The article forbids **depending**, not using. The operative test is therefore: *does any core aigentry
capability degrade to unusable when the plugin is absent?*

| Family | Ver | Core breaks without it? | Verdict |
|---|---|:-:|---|
| `superpowers` (obra, MIT) | 5.0.1 | **No.** `diagnose` names `superpowers:systematic-debugging` as an *escalation*; the loop is complete standalone. | **COMPLIANT as optional. DO NOT vendor.** |
| `ponytail` | 4.8.4 | **No.** Pure output-style modifier; no artifact reads it. | **COMPLIANT. No action.** |
| `openai-codex` | 1.0.3 | **No.** aigentry reaches Codex natively via `bin/dispatch.sh --cli codex` and telepty inject; the plugin wraps a path we already own. | **COMPLIANT as optional. DO NOT vendor.** |
| `skill-creator` (official) | — | **No.** Authoring aid. | **COMPLIANT. No action.** |
| `claude-md-management` (official) | 1.0.0 | **No.** Authoring aid. | **COMPLIANT. No action.** |

**Vendoring verdict: NONE, for any family.** MIT would permit vendoring superpowers, but forking 14
upstream skills to obtain a capability we already have a first-party path to is precisely the
over-engineering 제1조 forbids. **Vendoring is the more expensive answer, not the safe one.**

### §4.3 Two standing §17 corollaries adopted by this ADR

> **§17.3 corollary (NO-PLUGIN-DISTRIBUTION) — binding.** aigentry MUST NOT distribute any first-party
> capability as a Claude Code plugin/marketplace entry. Consuming third-party plugins optionally is
> fine (§17.2); **shipping our own capability that way is AI-CLI lock-in.** This is what rejected
> Alternative §3.3 and it applies to every future distribution proposal without re-litigation.
>
> **(r3) Re-grounded: the test is CHANNEL portability, not current destination coverage.** r1 justified
> this corollary by asserting that aigentry already reaches codex and gemini — which, for *skills*, is
> not true today (§2 per-CLI reach table). Reviewer 1 correctly flagged that a corollary rejecting the
> plugin for being Claude-only, while choosing a path that is also Claude-only today, argues against
> itself. The distinction that actually holds:
>
> | | Marketplace plugin | devkit installer (chosen) |
> |---|---|---|
> | Distribution **channel** | Claude Code's plugin system — **structurally** Claude-only | our own `install.sh`/`install.ps1` — **CLI-agnostic** |
> | Adding a codex destination | **impossible** without abandoning the channel | one more destination loop; format already compatible |
> | Current destination coverage | Claude only | Claude only — **a closable gap (§9 Q5), not lock-in** |
>
> Lock-in is a property of the **channel**, not of how many destinations are wired up yet. The plugin
> route forecloses cross-CLI delivery permanently; the devkit route defers it. **The corollary stands
> on that basis and no longer claims present cross-CLI skill parity.**

> **§17.4 obligation (WRITTEN-FALLBACK) — binding.** Wherever an aigentry document names an external
> plugin, the same document MUST state what happens without it. Two gaps close with this ADR:
> 1. `diagnose` → *"if `superpowers:systematic-debugging` is unavailable, continue this loop and
>    delegate cross-LLM per AI 작업 원칙 after 3 failed hypothesis classes."*
> 2. Any doc naming the codex plugin → *"Codex delegation = `bin/dispatch.sh --cli codex`; the codex
>    plugin is a convenience only."*
>
> Note `deliberation-gate` already satisfies this by construction — its frontmatter carries
> `prerequisites.mcp: [aigentry-deliberation]` **and** `fallback: self-criticism`. That is the pattern
> every prerequisite-bearing skill should follow.

### Q4: 모든 크로스 환경에서 동작하는가? — **PASS with 4 recorded defects** (제2조 크로스, 제14조)

The chosen mechanism is cross-platform **by construction**: `cp -R` / `Copy-Item -Recurse`, no
symlinks on the distribution path (§2 corollary 2), no absolute paths. Verified: **no `/Users/…` in any
`SKILL.md` in any of the five layers; no macOS-only commands (`pbpaste`/`osascript`/`screencapture`/
`brew`) anywhere; no hardcoded secrets anywhere** (`project-ops` uses `{NEW_TOKEN}` placeholders).

Four **pre-existing** defects were found and are recorded here so the ruling is not read as a clean
bill of health. None is caused by this ADR; all are unblocked by it:

| # | Defect | Evidence | Severity |
|---|---|---|---|
| **D1** | **`clipboard-image` is Linux-only and already ships publicly.** Only capture path is `DISPLAY=:1 xclip -selection clipboard -t image/png -o`; on macOS (no xclip) and Windows it silently writes an empty file. It is in devkit `files[]` today. | `skills/clipboard-image/SKILL.md` | **live §17.3 violation** |
| **D2** | `install.ps1` iterates `skills/` only; `install.sh` iterates `skills/*/ templates/skills/*/`. Windows users never receive `propose-next-task`. | `install.ps1:270` vs `install.sh:416` | 제2조 parity break |
| **D3** | Author's home path ships in the npm tarball: `templates/skills/propose-next-task/tests/*.md` contain `input_file: /Users/duckyoungkim/projects/aigentry-orchestrator/state/task-queue.json`, and `templates/skills/**` is in `files[]`. | grep, 3 hits | low (path disclosure) |
| **D4** | `project-ops` ships the `dmsdc-ai` account's operating procedure — repo list, "개인 계정이므로 repo-level secrets" — to every public user. | `SKILL.md:25,38-83` | low-med |
| **D5** *(r3)* | `deliberation-test` declares the trigger `"테스트 돌려"` ("run the tests") — generic enough to misfire for a user who merely wants their test suite run. Surfaced by the r3 decision to ship the skill (§2 corollary 5). | `skills/deliberation-test/SKILL.md:4-9` | low (tighten triggers) |

D1 and D4 are resolved by the §2 corollary-5 de-listing; D2, D3 and D5 are one-line fixes (§8.1 step 6).

### Q5: 사용자에게 "어떻게"를 강요하지 않는가? — **PASS**

A user runs `install.sh`/`install.ps1` once and every cross-cutting skill is present. The two-SSOT
split is an authoring-side rule; it is invisible at the consumption surface, where there is exactly one
directory (`~/.claude/skills/`).

---

## §5 Trade-off Matrix

Weights per template. Scores 1-5 (5 best); Total = Σ(weight × score).

| 기준 | Weight | **A** repo-SSOT | **B** own package | **C** plugin | **D** submodule | **Chosen** two-SSOT |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| 구현 복잡도 (new code needed) | 2 | 3 | 2 | 2 | 2 | **5** |
| 리스크 (capability loss) | 3 | **1** | 4 | 3 | 3 | **5** |
| 헌법 정합 (§1/§3/§17) | 5 | **1** | 3 | **1** | 2 | **5** |
| 크로스 플랫폼 호환 | 3 | 3 | 4 | **1** | 3 | **5** |
| 성능/비용 (release + maintenance) | 2 | 4 | 2 | 3 | 2 | **5** |
| 가역성 | 2 | 2 | 3 | 2 | 3 | **4** |
| **Total (weighted, max 85)** | | **35** | **53** | **31** | **42** | **83** |

**Arithmetic (r2 correction).** The r1 totals row was wrong for four of five columns — caught by
reviewer 2 and re-derived here. Σ(weight) = 17, so max = 85. Per column:

- **A** = 2·3 + 3·1 + 5·1 + 3·3 + 2·4 + 2·2 = 6+3+5+9+8+4 = **35** *(r1 said 32)*
- **B** = 2·2 + 3·4 + 5·3 + 3·4 + 2·2 + 2·3 = 4+12+15+12+4+6 = **53** *(r1 said 52)*
- **C** = 2·2 + 3·3 + 5·1 + 3·1 + 2·3 + 2·2 = 4+9+5+3+6+4 = **31** *(r1 said 32)*
- **D** = 2·2 + 3·3 + 5·2 + 3·3 + 2·2 + 2·3 = 4+9+10+9+4+6 = **42** *(r1 said 43)*
- **Chosen** = 2·5 + 3·5 + 5·5 + 3·5 + 2·5 + 2·4 = 10+15+25+15+10+8 = **83** *(r1 correct)*

**No individual score changed and the ranking is unchanged** — the chosen option still leads the
runner-up by 30 points, so the decision does not move. Only the totals row was wrong.

*(r3: reviewer 1's independent recomputation (N1) reached these same five corrected figures, so the
correction is cross-validated by both reviewers rather than resting on one.)*

The chosen option loses 2 points only on reversibility — the decision is one-way by nature (§1), which
is why it is an ADR rather than a report.

---

## §6 Backward Compatibility

**Existing consumers and their required changes:**

| Consumer | Impact | Migration |
|---|---|---|
| Orchestrator session | None. `orchestrate-turn` does not move; its symlink and tracking are unchanged. | **Additive, no migration.** |
| Every subordinate **Claude Code** session (analyst/coder/architect/…) | **Strictly additive** — gains all 9 promoted skills at `~/.claude/skills/`, previously present only on this machine and only by accident of local authoring. | None. |
| Subordinate **codex / gemini** sessions | **No change** — they read `$CODEX_HOME/skills/` or have no skill mechanism at all (§2 per-CLI reach table). Not a regression: they never received these skills. | None; closing the codex gap is §9 Q5. |
| Public devkit users (npm) | Gain 9 skills; lose 3 (`project-ops`, `clipboard-image`, `youtube-analyzer`) that were account-specific or platform-broken. | `install.sh --force` on next upgrade. Existing installs keep the 3 removed dirs until manually cleaned — harmless, and `aigentry doctor --skills` (§6 step 7) will report them. |
| Windows / Linux nodes | Gain `templates/skills/` install parity (D2 fix). | Re-run install. |
| telepty repo | **Zero.** Its 10 skills are untouched; ADR 2026-05-05 rule 2 is restated, not amended. | None. |
| `~/projects/claude-workspace-skills/` | Retired — its single skill folds into devkit. It is **not a git repo**, so this is the only copy. | `git add` in devkit **before** removing the original (INVARIANT below). |
| ADR 2026-05-05 / 2026-06-06 | **Extended, not superseded.** Rules 1-4 and the `orchestrate-turn` exception both survive verbatim; this ADR adds a tiebreak beneath them. | None. |

**Breaking change**: none.

---

## §7 Consequences

### §7.1 긍정적 결과

- Every Claude Code session role reaches every cross-cutting skill — the capability that Alternative A would have
  destroyed is instead extended from one machine to all of them.
- 9 previously untracked skills enter version control; the orchestrator repo converges to **exactly
  one** skill (`orchestrate-turn`), which is precisely the set that belongs there.
- Skill placement stops being a per-case argument: one question routes any future skill.
- Distribution to Linux/Windows nodes and sibling repos needs **a `files[]` edit and a version bump**
  — no new mechanism (§1.2).
- Two live §17 gaps close: the §17.3 corollary is written down before someone proposes a marketplace
  plugin, and the §17.4 fallbacks stop the superpowers/codex references from being silent dependencies.

### §7.2 비용 / 부정적 결과

- **17 skills are deleted.** 14 from the repo (12 unused mattpocock derivatives + 2 stale duplicates of
  newer global copies) and 3 dead user-global entries (2 empty dirs, 1 loose `.md` that Claude Code
  could never load). Justified — the 12 are unreachable from sandboxed sessions, unconfigured (their
  own text requires an `## Agent skills` block in AGENTS.md that was never created), and have zero
  inbound references — but it is a real reduction in nominal capability and is irreversible without the
  safety commit below. **Mitigating fact**: `skills-lock.json` at the repo root records each vendored
  skill's upstream origin and content hash (`mattpocock/skills`, `sourceType: github`, `skillPath`,
  `computedHash`), so the 14 repo skills are recoverable from upstream **independently** of git. That
  makes the deletions doubly reversible. (r1 flagged that this manifest was itself untracked and would
  be lost in the same sweep as the skills it documents; the orchestrator committed it in `f8ea49a`, so
  both recovery paths now exist before any deletion runs.)
- Cross-repo edits: devkit `package.json` `files[]`, `install.ps1`, three skill bodies. Small, but they
  cross a repo boundary and need a devkit release to reach anyone.
- The maintainer symlink/user copy asymmetry persists: on this machine 12 skills are symlinks into
  devkit while users get copies. That is deliberate (§2 corollary 2) but it means **the maintainer
  never exercises the code path users run** — mitigated by `aigentry doctor --skills`.

### §7.3 알려지지 않은 리스크

- **Skill discovery is not a documented, versioned contract.** The SANDBOX-REACH invariant rests on
  observed behavior (a sandboxed session sees `~/.claude/skills/` and not repo skills), not on a
  published guarantee. If Claude Code ever adds another discovery root — an env var, a settings key, a
  parent-directory walk — the constraint weakens and Alternative A becomes *possible* (still not
  advisable, since §17.1 and ADR 2026-05-05 reject it independently). **Re-verify if the harness
  changes.**
- Skill-name collisions across the global layer and any repo layer resolve by an undocumented
  precedence. Today only `orchestrate-turn` exists at repo level and no global skill shares the name,
  so the ambiguity is unexercised. Keeping the repo set at exactly one skill keeps it that way.
- 25 third-party skills remain outside our control. An upstream rename (e.g.
  `superpowers:systematic-debugging`) breaks a cross-reference in `diagnose`. The §17.4 fallback makes
  that degrade to "optional escalation unavailable" rather than a broken skill.

### §7.4 의존 컴포넌트 실패 시나리오

| Failure | Behavior |
|---|---|
| devkit npm publish fails / user on an old version | Skills stay at the previously installed version. Copies are self-contained — no runtime dependency on the devkit source tree. Degradation is staleness, never breakage. |
| `~/.claude/skills/` missing or unwritable | Sessions run with plugin + built-in skills only. No aigentry-core session flow depends on a skill being present — skills are behavioral guidance, not actuation (actuation lives in `bin/`, per ADR 2026-06-06). |
| Maintainer symlink into devkit dangles (repo moved/deleted) | That one skill vanishes for the maintainer only; users are unaffected (they hold copies). Detected by `aigentry doctor --skills`. |
| Windows clone materializes repo symlinks as text files (`core.symlinks=false`) | Affects a Windows clone of the **orchestrator repo** only — a maintainer scenario. Fix is `git config core.symlinks true` + Developer Mode, **not** a mechanism change. Users are unaffected: their path is `cp`, not symlink. |
| All external plugins absent | Every §4 Q3 verdict says core is unaffected; the §17.4 fallbacks are the written proof. |

---

## §8 Verification Plan

| # | Metric | Measurement | Success threshold | Rollback trigger |
|---|---|---|---|---|
| **M1** | Cross-cutting skills reach a sandboxed session | From a freshly dispatched **Claude Code** session (any role), confirm each of the 9 promoted skills is offered. **(r3)** All 9 ship — `deliberation-test` included (§2 corollary 5) — so 9/9 is the correct threshold; scope the check to claude workers, since codex/gemini are out of scope per §2 | 9/9 present | any missing → revert that skill's step-4 commit, restore from `<n>.bak` |
| **M2** | Repo holds only repo-coupled skills | `git ls-files .agents/skills \| cut -d/ -f3 \| sort -u` | exactly `orchestrate-turn` | extra entry → the routing test was misapplied; re-route it |
| **M3** | Nothing was lost unrecoverably | `git log --diff-filter=D --name-only` shows every deleted skill present in an earlier commit | 100% of deletions preceded by the step-1 import commit | any delete with no prior add → **stop the migration**, restore from backup |
| **M4** | Distribution parity across platforms | On a Linux and a Windows node: `npm i -g @dmsdc-ai/aigentry-devkit && install` then count `~/.claude/skills/` | identical skill set on all three OSes, incl. `propose-next-task` | mismatch → D2 fix incomplete |
| **M5** | No path/secret leakage in the published tarball | `npm pack --dry-run`, then grep the tarball for `/Users/` and token-shaped strings | 0 hits | any hit → fix before publish |
| **M6** | Copy drift stays visible | `aigentry doctor --skills` on the maintainer machine | reports 0 silent divergences | persistent divergence → convert the copy to a symlink locally |
| **M7** | §17.4 fallbacks present | grep for each external plugin name in our docs; each hit has a fallback sentence in the same document | 100% | any bare reference → §17.4 obligation unmet |

### §8.1 Migration order — 9 steps, with the binding invariant

> **INVARIANT (CAPABILITY-BEFORE-REMOVAL) — binding on the executing session.**
> **No skill may be deleted before (a) it is committed to git somewhere, and (b) any capability that
> supersedes it is already in place.** Concretely, and in this order: **step 1 MUST precede steps 2-3,
> and step 4 (promote) MUST precede steps 2-3 (delete)** — capability arrives before anything departs.
> Fourteen of the repo's fifteen skills were untracked at analysis time — deleting an untracked file has
> no reflog and no revert. The step-1 import commit is what converts every later removal into a
> `git revert`.
>
> *(r2 correction: r1 stated this as "step 4 **should** land before step 3" and published a dependency
> graph — `0 → 1 → {2, 3}` — that permitted the deletions to run first. That notation contradicted this
> very invariant. Both are corrected below; `MUST` is now the operative word, and the graph enforces it.)*

| # | Step | Repo | Risk | Rollback |
|---|---|---|---|---|
| 0 | Land the plan report | orchestrator | none | `git revert` |
| **1** ✅ | **SAFETY COMMIT** — imported all 14 untracked `.agents/skills/` dirs + their symlinks as-is (`03359b8`: 34 files + 15 symlinks), plus the `skills-lock.json` provenance manifest (`f8ea49a`). Both recovery paths — git history and upstream re-fetch — are now committed. | orchestrator | none (pure addition) | `git reset` |
| 2 | Salvage `diagnose/scripts/hitl-loop.template.sh` into the canonical copy + restore its by-path reference at step 10; **then** delete `.agents/skills/{caveman,diagnose}` | orchestrator | losing the HITL script | `git revert` |
| 3 | Delete the 12 unused mattpocock skills + symlinks | orchestrator | a skill was silently in use | `git revert` (enabled by step 1); **or** re-fetch from upstream per `skills-lock.json` |
| **4** | **Promote 9 skills into devkit `skills/`** (`caveman`, `context-manage`, `deliberation-gate`, `deliberation-test`, `diagnose`, `grill-with-adr`, `sawe`, `session-create`, `work-breakdown`); **add all 9 to `files[]`** *(r3 — the r1 "except `deliberation-test`" carve-out is withdrawn, §2 corollary 5)* | devkit | broken symlink silently drops a skill | keep `<n>.bak` until verified; `rm` symlink + `mv` back |
| 5 | Fold `workspace-lifecycle` into devkit; retire the non-git orphan directory | devkit | it is the **only** copy | `git add` in devkit **before** removing the original |
| 6 | Fix D1-D4 (§4 Q4) — independent, any order | devkit | D1's platform branch is the only real behavior change | `git revert` per fix |
| 7 | Add `aigentry doctor --skills` drift guard (read-only) | devkit | none | `git revert` |
| 8 | Docs: AGENTS.md routing line + §4 absorption of the `dustcraw-task-feed` rule; delete the 2 empty dirs; add the two §17.4 fallback sentences; land **this ADR** | orchestrator | none | `git revert` |

**Execution order (authoritative — the table above is a step *catalog*, numbered for reference, not a
running order):**

```
0 → 1 → 4 → {2, 3} → 8
         └→ 5
         └→ 7
6  — independent, any time
```

- `1 → 4 → {2, 3}` enforces CAPABILITY-BEFORE-REMOVAL: safety commit, then promotion, then deletions.
- `4 → 2` is a **hard data dependency**, not merely a preference: step 2 salvages
  `hitl-loop.template.sh` **into the canonical `diagnose`**, and the canonical copy is the devkit one
  that step 4 creates. Running step 2 first would salvage into a file that is about to be superseded.
- `4 → 3` is the invariant: several of the 12 deletions are justified by capabilities that land in
  step 4 (e.g. `grill-me` + `grill-with-docs` are superseded by `grill-with-adr`).
- `4 → 5` (same repo, same promote pattern) and `4 → 7` (the drift guard has nothing to check until
  the promoted set exists).
- `6` (D1-D4) touches only devkit packaging/platform code and shares no file with any other step.
- `8` last — it lands the AGENTS.md routing line and this ADR, which describe the finished end state.

**Progress**: steps **0, 1 complete** as of 2026-07-26 (orchestrator). Step 1 is confirmed complete
including `skills-lock.json` (see the step-1 row). Steps 2-8 pending; **step 4 is the next one
eligible to run.**

---

## §9 Open Questions

**Q1 — T2 reviewer threshold (r2 update).** `type=adr × scope=ecosystem × decision_type=one-way` →
**T2, 2 reviewers** (`references/frontmatter-schema.md`). The **decision content** is user-approved
(2026-07-26). Review state:

| Reviewer | Round | Verdict | State |
|---|---|---|---|
| 2 (gemini-family) | r1 | **REQUEST_CHANGES** — 3 blocking (B1-B3) + 2 non-blocking | resolved in r2 (`r2_basis`) |
| 2 (gemini-family) | r2 | **ACCEPT** | all B1-B3 resolved, no new contradictions, arithmetic recomputed correct |
| 1 (codex) | r2 | **REQUEST_CHANGES** — 2 blocking (B1-B2, non-overlapping) + 3 non-blocking | resolved in r3 (`r3_basis`) |
| 1 (codex) | r3 | **ACCEPT** — 1 non-blocking note (§1.3 wording remnant) | note applied in r4 |

**T2 threshold (2 reviewers) SATISFIED.** Cumulative across rounds: 5 blocking + 5 non-blocking
findings, **all resolved**.

**How the two rounds differ, and why it matters.** Reviewer 2's three findings were defects in the
ADR's *own internal consistency* — arithmetic, a dependency graph contradicting its own invariant, a
stale progress note. Reviewer 1's two findings are different in kind: they are **factual defects in
the decision's premises** — a shipped/not-shipped contradiction that would have failed the migration's
own success gate, and an unverified cross-CLI reach claim that the §17.3 constitutional ruling was
resting on. r3 therefore changes substance, not just wording:

- **§2 corollary 5** reverses the `deliberation-test` carve-out (now ships).
- **§2** gains a per-CLI reach table and an explicit Claude-Code scope line.
- **§3.3 / §4.3** re-ground the §17.3 corollary on channel-vs-destination portability rather than on
  a cross-CLI parity claim that did not hold for skills.

**What did not change**: the routing rule and its tiebreak, the three-SSOT split, all four
alternatives' rejections, the five constitution verdicts, and every §5 score. The decision stands;
its justification is now accurate.

**`status` is `accepted` as of r4 (2026-07-26)** — user approval plus both reviewer ACCEPTs; no waiver
was needed. **Q1 is closed.** Migration may proceed per §8.1; step 4 is the next eligible step.

**Q5 — Cross-CLI skill delivery (codex / gemini). NEW in r3; raised by reviewer 1 B2.**
This ADR is scoped to Claude Code (§2). The gap and its shape, verified:

| CLI | Situation | Path to closing it | Cost |
|---|---|---|---|
| **codex** | reads `$CODEX_HOME/skills/`, which devkit never writes | add a second destination loop to `install.sh`/`install.ps1`; `SKILL.md` frontmatter format already matches (verified against `~/.codex/skills/frontend-skill/SKILL.md`) | small — one loop, no format work |
| **gemini** | **no skill mechanism at all**; role context arrives as a cwd `GEMINI.md` | genuinely different mechanism — context-file composition, not skill-dir install | needs its own design |

Deferred rather than decided here because gemini's half is a different problem wearing the same name,
and bundling it would have this ADR design two mechanisms at once (§1 경량). **Recommend a follow-up
ADR** scoped to cross-CLI capability delivery. Until then, cross-cutting skills are a Claude Code
capability, and the §17.3 corollary rests on channel portability (§4.3), not on present parity.

**Q2 — `.agents/` vs `.claude/` as the repo-side source.** This ADR preserves the existing convention
(`.agents/skills/` is the source, `.claude/skills/` the symlink view) without re-deriving it. With the
repo set reduced to a single skill, the two-directory dance arguably costs more than it earns. Not
worth changing now — **revisit only if a second repo-coupled skill ever appears.**

**Q3 — Trigger for revisiting Alternative §3.2.** The separate-package option becomes correct if
skills ever need a release cadence independent of devkit — e.g. a skill hotfix blocked behind an
unrelated devkit change. **Recorded so the trigger is recognized rather than rediscovered.**

**Q4 — Re-verify SANDBOX-REACH after any Claude Code harness upgrade that changes skill discovery**
(§7.3). The check is two commands: dispatch a session, ask whether a repo-only skill is offered.
