---
type: adr
status: proposed
scope: ecosystem
decision_type: one-way
tier: T2
date: 2026-07-26
author: aigentry-architect-claude (a739s-architect)
acceptance_basis: "Decision content approved in full by the user 2026-07-26 (all 4 open decisions per architect recommendation, on report docs/reports/2026-07-26-skill-productionization-plan.md). T2 reviewer threshold (2) NOT yet satisfied — see §9 Q1."
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
| Upstream provenance record for vendored skills | **YES (untracked)** | `skills-lock.json` at repo root — `{source, sourceType, skillPath, computedHash}` per skill |
| **Routing tiebreak for skills specifically** | **NO** | ← the only gap this ADR fills |
| **Written §17.4 fallbacks for referenced plugins** | **NO** | ← second gap this ADR fills |

The gap is one sentence of routing rule and two sentences of fallback documentation. **No new script,
no new package, no new sync mechanism.**

### §1.3 The decisive constraint — role-sandbox unreachability

`bin/dispatch.sh:462-470` (#431, enforcing ADR 2026-05-12) spawns every subordinate session with:

> "Compute a sandbox spawn cwd (`$HOME/.aigentry/role-sandbox/<role>-<sid>/`) with no CLAUDE.md →
> no project auto-discovery contamination"

Verified 2026-07-26 from inside such a sandbox (the architect session that authored this ADR):

```
$ ls -la $HOME/.aigentry/role-sandbox/architect-a739s-skills-plan/
total 0                      # empty — no .claude/, no .agents/
$ grep -rn "role-sandbox" bin/*.sh bin/lib/*.sh | grep -iE "skill|\.claude"
                             # ∅ — nothing seeds skills into the sandbox
```

Claude Code resolves repo-level `.claude/skills/` **relative to cwd**. The sandbox is deliberately
clean — that is the entire point of #431. Therefore:

> **INVARIANT (SANDBOX-REACH):** a skill placed in any repo's `.claude/skills/` is visible **only** to a
> session whose cwd is that repo. Under #431 that is the orchestrator session and no other. Every
> subordinate session (analyst / coder / architect / …) can reach **only** `~/.claude/skills/`.

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

| SSOT | Owns | Reaches | Delivery mechanism |
|---|---|---|---|
| **devkit `skills/`** | every **cross-cutting** skill — any skill a session of any role may need | **every session**, via `~/.claude/skills/` | npm `files[]` → `install.sh` `cp -R` / `install.ps1` `Copy-Item` |
| **orchestrator `.agents/skills/`** | **repo-coupled** skills only — those invoking *this repo's* `bin/` by path. Today: exactly `orchestrate-turn`. | orchestrator session only — which is correct, since only it runs `bin/` | relative symlink into `.claude/skills/`; both committed |
| **telepty `skills/`** | reference docs for telepty's own CLI/protocol surface | telepty install | unchanged (ADR 2026-05-05 §3.1 rule 2) |

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
   from `files[]`**: `project-ops`, `clipboard-image`, `youtube-analyzer`. Maintainer-only tooling
   (`deliberation-test`) likewise git-tracked, not packed.

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
- **Cons / rejection**: **§17.3 violation, decisive.** The plugin/marketplace mechanism is
  **Claude-Code-only**. aigentry dispatches to codex and gemini sessions as first-class citizens
  (`bin/dispatch.sh --cli {claude,codex,gemini}`, `tests/dispatch/T47_dispatch_role_codex_gemini.sh`).
  Shipping core capability through a Claude-only channel is exactly the AI-CLI lock-in the
  constitution forbids. This rejection generalizes into the standing corollary in §4.3.

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

**Zero new dependencies, zero new code.** Distribution = the existing `files[]` + `cp -R`/`Copy-Item`
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
> capability as a Claude Code plugin/marketplace entry. The mechanism is Claude-Code-only; aigentry
> dispatches to codex and gemini as first-class citizens. Consuming third-party plugins optionally is
> fine (§17.2); **shipping our own capability that way is AI-CLI lock-in.** This is what rejected
> Alternative §3.3 and it applies to every future distribution proposal without re-litigation.

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

D1 and D4 are resolved by the §2 corollary-5 de-listing; D2 and D3 are one-line fixes (§6 step 6).

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
| **Total (weighted, max 85)** | | **32** | **52** | **32** | **43** | **83** |

The chosen option loses 2 points only on reversibility — the decision is one-way by nature (§1), which
is why it is an ADR rather than a report.

---

## §6 Backward Compatibility

**Existing consumers and their required changes:**

| Consumer | Impact | Migration |
|---|---|---|
| Orchestrator session | None. `orchestrate-turn` does not move; its symlink and tracking are unchanged. | **Additive, no migration.** |
| Every subordinate session (analyst/coder/architect/…) | **Strictly additive** — gains 9 skills at `~/.claude/skills/` that were previously present only on this machine and only by accident of local authoring. | None. |
| Public devkit users (npm) | Gain 9 skills; lose 3 (`project-ops`, `clipboard-image`, `youtube-analyzer`) that were account-specific or platform-broken. | `install.sh --force` on next upgrade. Existing installs keep the 3 removed dirs until manually cleaned — harmless, and `aigentry doctor --skills` (§6 step 7) will report them. |
| Windows / Linux nodes | Gain `templates/skills/` install parity (D2 fix). | Re-run install. |
| telepty repo | **Zero.** Its 10 skills are untouched; ADR 2026-05-05 rule 2 is restated, not amended. | None. |
| `~/projects/claude-workspace-skills/` | Retired — its single skill folds into devkit. It is **not a git repo**, so this is the only copy. | `git add` in devkit **before** removing the original (INVARIANT below). |
| ADR 2026-05-05 / 2026-06-06 | **Extended, not superseded.** Rules 1-4 and the `orchestrate-turn` exception both survive verbatim; this ADR adds a tiebreak beneath them. | None. |

**Breaking change**: none.

---

## §7 Consequences

### §7.1 긍정적 결과

- Every session role reaches every cross-cutting skill — the capability that Alternative A would have
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
  makes the deletions doubly reversible — but `skills-lock.json` is **itself untracked**, so it must be
  committed with step 1 or the second recovery path is lost along with the first.
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
| **M1** | Cross-cutting skills reach a sandboxed session | From a freshly dispatched session (any role), confirm each of the 9 promoted skills is offered | 9/9 present | any missing → revert that skill's step-4 commit, restore from `<n>.bak` |
| **M2** | Repo holds only repo-coupled skills | `git ls-files .agents/skills \| cut -d/ -f3 \| sort -u` | exactly `orchestrate-turn` | extra entry → the routing test was misapplied; re-route it |
| **M3** | Nothing was lost unrecoverably | `git log --diff-filter=D --name-only` shows every deleted skill present in an earlier commit | 100% of deletions preceded by the step-1 import commit | any delete with no prior add → **stop the migration**, restore from backup |
| **M4** | Distribution parity across platforms | On a Linux and a Windows node: `npm i -g @dmsdc-ai/aigentry-devkit && install` then count `~/.claude/skills/` | identical skill set on all three OSes, incl. `propose-next-task` | mismatch → D2 fix incomplete |
| **M5** | No path/secret leakage in the published tarball | `npm pack --dry-run`, then grep the tarball for `/Users/` and token-shaped strings | 0 hits | any hit → fix before publish |
| **M6** | Copy drift stays visible | `aigentry doctor --skills` on the maintainer machine | reports 0 silent divergences | persistent divergence → convert the copy to a symlink locally |
| **M7** | §17.4 fallbacks present | grep for each external plugin name in our docs; each hit has a fallback sentence in the same document | 100% | any bare reference → §17.4 obligation unmet |

### §8.1 Migration order — 9 steps, with the binding invariant

> **INVARIANT (CAPABILITY-BEFORE-REMOVAL) — binding on the executing session.**
> **No skill may be deleted before (a) it is committed to git somewhere, and (b) any capability that
> supersedes it is already in place.** Concretely: step 1 precedes steps 2-3; step 4 (promote) should
> land **before** step 3 (delete), so capability arrives before anything departs. Fourteen of the repo's
> fifteen skills were untracked at analysis time — deleting an untracked file has no reflog and no
> revert. The step-1 import commit is what converts every later removal into a `git revert`.

| # | Step | Repo | Risk | Rollback |
|---|---|---|---|---|
| 0 | Land the plan report | orchestrator | none | `git revert` |
| **1** | **SAFETY COMMIT — import all 14 untracked `.agents/skills/` dirs + their symlinks as-is** | orchestrator | none (pure addition) | `git reset` |
| 2 | Salvage `diagnose/scripts/hitl-loop.template.sh` into the canonical copy + restore its by-path reference at step 10; **then** delete `.agents/skills/{caveman,diagnose}` | orchestrator | losing the HITL script | `git revert` |
| 3 | Delete the 12 unused mattpocock skills + symlinks | orchestrator | a skill was silently in use | `git revert` (enabled by step 1); **or** re-fetch from upstream per `skills-lock.json` |
| **4** | **Promote 9 skills into devkit `skills/`** (`caveman`, `context-manage`, `deliberation-gate`, `deliberation-test`, `diagnose`, `grill-with-adr`, `sawe`, `session-create`, `work-breakdown`); add to `files[]` **except `deliberation-test`** | devkit | broken symlink silently drops a skill | keep `<n>.bak` until verified; `rm` symlink + `mv` back |
| 5 | Fold `workspace-lifecycle` into devkit; retire the non-git orphan directory | devkit | it is the **only** copy | `git add` in devkit **before** removing the original |
| 6 | Fix D1-D4 (§4 Q4) — independent, any order | devkit | D1's platform branch is the only real behavior change | `git revert` per fix |
| 7 | Add `aigentry doctor --skills` drift guard (read-only) | devkit | none | `git revert` |
| 8 | Docs: AGENTS.md routing line + §4 absorption of the `dustcraw-task-feed` rule; delete the 2 empty dirs; add the two §17.4 fallback sentences; land **this ADR** | orchestrator | none | `git revert` |

Dependency: `0 → 1 → {2, 3}`; `4 → 5`; `6` independent; `7` after `4`; `8` last. Step 4 is independent
of 1-3 and is **safest run before step 3**.

Steps 0 and 1 are complete as of 2026-07-26 (orchestrator).

---

## §9 Open Questions

**Q1 — T2 reviewer threshold.** `type=adr × scope=ecosystem × decision_type=one-way` → **T2, 2
reviewers** (`references/frontmatter-schema.md`). The **decision content** is user-approved
(2026-07-26), but no independent reviewer has run. Orchestrator must either commission a 2-LLM
deliberation (codex + gemini, matching ADR 2026-05-05's precedent) or record an explicit waiver
citing the user approval. **`status` stays `proposed` until one of those happens.** Steps 1 and 4 are
safe to execute meanwhile — both are purely additive.

**Q2 — `.agents/` vs `.claude/` as the repo-side source.** This ADR preserves the existing convention
(`.agents/skills/` is the source, `.claude/skills/` the symlink view) without re-deriving it. With the
repo set reduced to a single skill, the two-directory dance arguably costs more than it earns. Not
worth changing now — **revisit only if a second repo-coupled skill ever appears.**

**Q3 — Trigger for revisiting Alternative §3.2.** The separate-package option becomes correct if
skills ever need a release cadence independent of devkit — e.g. a skill hotfix blocked behind an
unrelated devkit change. **Recorded so the trigger is recognized rather than rediscovered.**

**Q4 — Re-verify SANDBOX-REACH after any Claude Code harness upgrade that changes skill discovery**
(§7.3). The check is two commands: dispatch a session, ask whether a repo-only skill is offered.
