# Public installation & onboarding path (proposal) — #1149

pi1149-architect · 2026-09-10 · rev 2 (rev 1 = `ffdbd1d`). Base `d8be6f3`, branch `docs/1149-public-onboarding`. **Design only — nothing installed, resolved,
built, tested, published or run.**

**Evidence grades.** `[M]` read from a committed source object · `[R]` package *metadata* from the one registry round in §0 · `[WIP]` present only in a
sibling working tree, not in the cited commit · `[U]` unmeasured · `[P]` proposed, not implemented. **No claim here rests on an executed install, resolver
run, CI run, or runtime observation.**

Siblings read-only at `aigentry` `f959b29`, `aigentry-devkit` `bb7876b`. **Every line number below comes from `git show <sha>:<path>`, not the working tree**
— rev 1 cited working-tree lines and got `install.sh` wrong by ~45. The devkit dirty count moved 84→51 between reports because the two used different flags,
not because anything was cleaned: `git status --porcelain` = 51 entries (16 modified tracked + 35 untracked *entries*, directories collapsed);
`--porcelain -uall` = 84 per-file. Same tree, two counting semantics.

## 0. Registry metadata (one round, 2026-09-10T11:40Z, not re-fetched for this revision)

Anonymous read-only `GET https://registry.npmjs.org/<name>`, 6 packages, all **HTTP 200**.

| URL | latest | published | engines | os | bin | lifecycle scripts |
|---|---|---|---|---|---|---|
| `…/@dmsdc-ai%2Faigentry` | 0.1.1 | 2026-07-05 | node>=18 | — | `aigentry` | none |
| `…/@dmsdc-ai%2Faigentry-devkit` | 0.1.14 | 2026-07-26 | node>=18 | — | `aigentry-devkit`, `-bootstrap` | postinstall = `echo` only |
| `…/@dmsdc-ai%2Faigentry-orchestrator` | 0.2.0 | 2026-08-15 | node>=20 | darwin,linux | `aigentry-orchestrator` | prepack only |
| `…/@dmsdc-ai%2Faigentry-telepty` | 0.8.3 | 2026-09-08 | node>=20 | — | `telepty`(+3) | **postinstall + preuninstall** |
| `…/@dmsdc-ai%2Faigentry-brain` | 0.3.1 | 2026-07-26 | node>=20 | — | `aigentry-brain`(+2) | **postinstall `… \|\| true`** |
| `…/@dmsdc-ai%2Faigentry-deliberation` | 0.0.47 | 2026-06-22 | node>=18 | — | `deliberation-*`(+2) | postversion `install.js` |

This establishes what each package's *metadata declares*. It does **not** establish that any install command succeeds: no `npm install`, `npm pack` or
resolver dry-run was executed, the transitive closure was never resolved, and `@dmsdc-ai/aigentry-ssot`, `@dmsdc-ai/aigentry-logger` and `@dmsdc-ai/aterm` —
direct dependencies of the orchestrator, of four packages, and of the meta package — were **not queried** (6-package bound). **Installability of every package
below is `[U]`.**

1. **The front door declares a set older than its own docs invoke.** `@dmsdc-ai/aigentry@0.1.1` declares `telepty ^0.6.6`, `devkit ^0.0.22`, `brain ^0.2.8`
   `[R]`; published versions matching those ranges exist (`0.6.19`/`0.0.22`/`0.2.8`) `[R]`, so the ranges are not dead — but **no resolution was run and no
   install outcome is claimed** `[U]`. Every documented command is `npx --yes --package @dmsdc-ai/aigentry-devkit …` `[M aigentry/README.md:129]`, targeting a
   package whose `latest` is `0.1.14` `[R]`, so two devkit versions can be in play unannounced. This refines #1144 to **declared-range staleness plus a
   doc/dependency split**, not a proven install failure.
2. **The published orchestrator contradicts both READMEs.** `[R]` records `@dmsdc-ai/aigentry-orchestrator@0.2.0` (2026-08-15). `[M
   orchestrator/README.md:5]`: "not published to npm and has no public install path". `[M aigentry/README.md:149]`: "there's no npm package to install". `[M
   ecosystem.json]` records the name unscoped with `"published": false`.
3. **Four records of the telepty version disagree** `[M]`: `ecosystem.json` `0.7.1`; `devkit/config/installer-manifest.json` pins the install to
   **`0.1.45`**; the orchestrator declares `^0.8.0`; the meta package `^0.6.6`.
4. **The most careful install code already exists** `[M bin/init/cli.mjs @ d8be6f3]`: platform gate (exit 2, message names WSL2); dependency checks whose
   banner reads "detect only; nothing is installed"; refusal to write into a non-empty or git-tracked directory (exit 4); key-wise `~/.aigentry/config.json`
   merge that names the foreign keys it declined to touch; keep/overwrite/backup prompt for `CONSTITUTION.md`; `state/` never deleted; `--dry-run`; exit map
   0/2/3/4/5/6/7; manifest-digest stamp. `tests/packaging/smoke-init.sh` and `T96_ship_set_agreement.sh` are committed and **written to** pack the tarball and
   install it into a throwaway `HOME`+`--prefix`; **no run of either was fetched or observed** `[U]`. Extend this pattern; do not add an umbrella.

## 1. Recommended public journey

One name: **`aigentry`** — already published `[R]`, already the name the docs print `[M]`. Each step delegates to a binary that already owns it: no new
package, daemon or framework (Article 1 / 17).

| # | Step | Command | Grade |
|---|---|---|---|
| 1 | Install front door | `npm i -g @dmsdc-ai/aigentry` | `[M]` documented · outcome `[U]` |
| 2 | Inventory | `aigentry status` | `[M aigentry/bin/aigentry.js:38]` — status board only |
| 3 | Prerequisites | `aigentry-devkit doctor` | `[M devkit bin:32,64]` · `aigentry doctor` `[P]` |
| 4 | Base install | `npx --yes --package @dmsdc-ai/aigentry-devkit aigentry-devkit install --profile core` | `[M devkit bin:29,60]` · `aigentry setup` `[P]` |
| 5 | Connect **one** provider | reuse your existing `claude`/`codex`/`gemini` login | `[P]` policy, §3 |
| 6 | Bind work to a task | record the task **before** any executable step | `[P]`, §4 (#1150) |
| 7 | Scope a project | `aigentry-devkit workspace-init --cli claude --cwd <project>` | `[M devkit bin:38,41,44]` |
| 8 | First task → review → production acceptance | run your CLI there | `[M]` scaffold · acceptance `[P]` |
| 9 | *Optional* automation | `aigentry-orchestrator init --dry-run`, then without | `[M]`, opt-in |

Steps 2–4 and 7 carry no ordering constraint against each other beyond needing step 1's binaries; nothing here asserts a serial pipeline where steps are
independent.

`aigentry setup` and `aigentry doctor` are printed as user commands at `[M devkit/README.md:163-166,196]` but accepted by **no** binary — `aigentry` takes
only `status|version|help` and errors otherwise `[M aigentry/bin/aigentry.js:38,59,62,83]`. The `[P]` aliases close that documentation bug. Their prerequisite
is an agreed delegation interface: argv passthrough, exit-code propagation, and defined behaviour when the delegate is absent or a different version than
`status` reports. **No implementation size, effort or duration is estimated here.**

## 2. Ownership: existing vs proposed

| Layer | Package | Tier |
|---|---|---|
| Front door | `@dmsdc-ai/aigentry` — name, status board; delegation `[P]` | required |
| Environment setup | `@dmsdc-ai/aigentry-devkit` — `setup/doctor/profiles/init/workspace-init/scaffold/update/status/bootstrap/breakdown` `[M]` | required |
| Transport | `@dmsdc-ai/aigentry-telepty` — PTY daemon, inject | required |
| Multi-AI debate | `@dmsdc-ai/aigentry-deliberation` | required today; optional `[P]` |
| Memory | `@dmsdc-ai/aigentry-brain` | optional in profiles; **declared meta dep** |
| Terminal | `@dmsdc-ai/aterm` | **declared meta dep**; license `[U]` |
| Automation | `@dmsdc-ai/aigentry-orchestrator` — control workspace, dispatch, HITL gate | opt-in, advanced |
| Crawl / registry / amplify | `dustcraw`, `registry-wiring`, `amplify` | optional |

`[M devkit/config/installer-manifest.json @ bb7876b]`: `required: true` holds for `devkit-core`, `telepty`, `deliberation`; `core.components` = those three;
`optional_components` already exists as a field and is used by `autoresearch-public`.

**A minimal base is a proposed contract, not a current property.** `@dmsdc-ai/aigentry@0.1.1` declares `aterm`, `telepty`, `devkit`, `brain` **and**
`deliberation` as dependencies `[R]` — installing the front door today asks for all five. Moving `deliberation` between manifest fields would **not** remove
it from that npm closure, nor satisfy any code that requires it. The `[P]` is: define a minimal base, then optionalize — **gated on** (a) an enumerated list
of runtime consumers of `brain`, `deliberation` and `aterm` on the steps 1–8 path, (b) proof each step works with the component absent, (c) a matching change
to the meta package's declared dependencies. None of (a)–(c) was measured.

## 3. Prerequisites, OS and credential honesty

- **Declared Node ranges are mixed** `[R]`: meta and devkit `>=18`; telepty, brain, orchestrator `>=20`. **Proposed public baseline: Node 20**, one number
  covering the declared set. What a Node 18 user actually hits — resolver refusal, `EBADENGINE` warning, or a later runtime fault — is `[U]`.
- **OS claims must not outrun what exists.** Only the orchestrator declares `os: [darwin, linux]` `[R]`; its Windows path is a **documented hint**, not a
  tested one (`bin/init/cli.mjs` exits 2 with a message naming WSL2 `[M]`; Windows jobs exist in the workflow file `[M]`, no run fetched `[U]`). Devkit's
  workflow declares `ubuntu/macos/windows × node 18/20/22` `[M ci.yml:15]` with only `npm ci` and `node bin/aigentry-devkit.js --help` as steps `[M
  ci.yml:28,31]` — declared *test intent* covering CLI startup; not an install test, not a green result, not platform support. **Say: macOS and Linux are the
  declared and developed targets; Windows is unverified; WSL2 is a documented hint.**
- **No `curl | sh`** in the recommended path — none present in `[M devkit/install.sh @ bb7876b]`.
- **One unprompted privilege escalation is committed:** `[M devkit/install.sh:330-336 @ bb7876b]` runs `sudo apt-get update && sudo apt-get install -y tmux`
  (plus dnf/yum/pacman) with no prompt. `[P]` replace with detect-and-print, following `bin/init/cli.mjs`'s detect-only step.
- **Failure classification is documented, its implementation is not committed.** `[M devkit/README.md:155,178]` documents `AIGENTRY_INSTALL_FALLBACK_MODE`
  and a `permission` (`EACCES`) → **HALT** class. `lib/install-fallback.js` is **`[WIP]`** — absent from `bb7876b`, present only in the working tree.
  `package.json` ships `lib/**`, so the published tarball may or may not contain it `[U]`. **Rev 1 cited this as implemented behaviour; that was wrong.** It
  is a documented intention pending tarball proof.
- **Credentials: state the policy, do not claim the property.** `[M devkit bin/aigentry-devkit.js:105,400,408]` reads `~/.claude/.mcp.json` and
  `~/.gemini/settings.json`; `[M bin/init/cli.mjs]` merges `~/.aigentry/config.json` key-wise, naming untouched foreign keys. **Proposed auth policy: reuse
  exactly one existing CLI login; copy, store and forward no provider credential.** That is a policy to enforce and test, **not an established fact** — no
  audit of credential-state copying was performed, and #1142 has that concern open. Absence of evidence is not evidence of absence.

## 4. Everyday workflow

**Committed today** `[M]`: per-project scoping via `workspace-init` / `scaffold --project` with `--dry-run` and `--backup` on by default (`devkit
bin:38,41,44`); profile presets; `--resume <phase|component>` parsed, validated against the manifest's components and carried into the plan (`devkit
bin:140,206-211,269`); per-attempt install logs under `${XDG_CONFIG_HOME:-$HOME/.config}/aigentry-devkit/logs/`; a documented exit map and generated
`GETTING-STARTED.md`; the HITL gate `open|list|show|approve|reject|remind` (`bin/hitl.sh:6`); the pre-dispatch strictness knob `AIGENTRY_TASK_GATE`, default
`hard`, downgradable to `warn`/`off` (`src/dispatch/cli.ts:511,558-559`); `state/task-queue.json` preserved across re-init.

**Proposed** `[P]`: the §1 aliases; a status line naming the connected provider; and the task-binding contract — work bound to a task **before** any
executable step, immutable attempt/artifact provenance, task-bound retry and recovery, explicit production acceptance. **#1150 owns that enforcement contract;
this document references it and deliberately does not re-specify it.**

**Automation control is a real gap with existing owners.** HITL verbs gate a *pending* request; `AIGENTRY_TASK_GATE` sets *pre-dispatch* strictness. Neither
stops work already running, and a search of committed `bin/` and `src/` found **no pause, stop, drain or abort verb** for a running loop `[M]`. "Don't run
step 9" is an opt-out from starting, **not a stop switch**. Required `[P]`: supported `pause`/`resume`/`drain`/`abort` with defined in-flight semantics, plus
a budget and approval contract. Approval, cost and retry work already sits with **#1136** and **#1148** — rev 1's "no owner today" was wrong. Neither is
shipped: #1136 has TEST-ONLY counterpart evidence with source retest, 2×LOW security, caller wiring and activation incomplete; #1148 is observations, not
approved defaults or runtime application.

For the docs: `aigentry-orchestrator init` **only materialises a workspace** — its subprocess calls are `command -v` probes and `install-instructions.sh`
`[M]`. Booting is a separate explicit `bin/orchestrator-boot.sh` `[M]`. **Installing the orchestrator does not start automation.**

## 5. Packaging, release, update, removal

1. **Ship an approved release set.** Make one record — `ecosystem.json` extended — the approved compatible set for a release, and generate the meta package's
   declared ranges and the installer manifest's pins from it. **CI must verify the shipped artifacts match the approved set and that the tarball identity is
   the tested one; it must NOT require equality with the registry's current `latest`** — a newer upstream release is not compatibility evidence and must never
   break a supported pinned release. `devkit/scripts/sync-readme-tooling.mjs` already exists for the README table and is the natural place to extend. Owners:
   #1144, #1146.
2. **Acceptance = the tested tarball into a clean HOME.** `smoke-init.sh` + `T96` are committed for the orchestrator `[M]`; devkit's declared test is
   `--help` `[M ci.yml:31]`; the meta package declares no scripts `[R]`. Adopting requires checking each consumer's interface first — different bins, no
   `init` verb, different state — so this is "adopt the acceptance *shape*", not "run the same scripts". Owners: #1143, #1146.
3. **Postinstall transparency.** Publish §0's lifecycle column: telepty declares postinstall + preuninstall; brain declares `bin/aigentry-brain-setup.mjs ||
   true`, where `|| true` **suppresses a failed setup's exit status**, so `doctor` should detect what postinstall swallowed; devkit declares an echo `[R]`.
   Document an `--ignore-scripts` path and what must then be run by hand.
4. **Update / interrupt / remove.** Update moves the whole approved set, never per-package `latest`. Interruption has `--resume` `[M]`; correctness is
   #1147's. Removal is a gap: only telepty declares `preuninstall` `[R]`, no `aigentry uninstall` exists `[M]`. Scope rollback honestly — config and `state/`
   preserved, MCP registrations reverted, **installed npm packages not removed**.

## 6. Delivery slices and acceptance criteria

| Slice | Content | Acceptance |
|---|---|---|
| **S1 — Correct the record** (docs/metadata only) | Fix the "not published" lines in both READMEs; fix `ecosystem.json`'s orchestrator row (scoped name, `published: true`, 0.2.0); publish §0 with its grades; query `ssot`/`logger`/`aterm` and record aterm's license | Every publication/version claim in both READMEs matches a same-day registry response; the 3 unqueried deps have a recorded status |
| **S2 — One front door** | `aigentry setup\|doctor\|project init\|orchestrator init` delegation; declared engines raised to §3's baseline; meta ranges regenerated from the approved set | The §1 journey to step 4 completes on a clean HOME using the delegating commands; `aigentry status` reports the version actually present and says so when it differs from what a `npx` invocation would use |
| **S3 — Honest install** | Replace the committed `sudo` with detect-and-print; commit or remove the `[WIP]` fallback implementation the README documents; surface brain's suppressed postinstall failure in `doctor`; **then** optionalize `deliberation` once §2's (a)–(c) hold | `setup --profile core` completes with zero `sudo` invocations; `doctor` reports a failed brain MCP registration as a failure; every README-documented env var maps to committed code |
| **S4 — Release identity** | Approved-set generation + tarball-identity check in CI for devkit and meta, via each package's own interface | CI installs the **tested tarball** into a throwaway HOME+prefix and runs the §1 journey to step 4; an artifact not matching the approved set fails CI; a newer upstream `latest` alone does not |
| **S5 — Automation control** | `pause/resume/drain/abort` + budget/approval contract, coordinated with #1136 and #1148 | A running loop can be paused and aborted with defined in-flight semantics; a budget ceiling is enforced before dispatch |

S1 is a prerequisite for S2's version claims. S3, S4 and S5 are independent of each other and can proceed in parallel once S1 lands. No step count, install
duration or effort figure is offered — none was measured; any such number is a target to set after S4, never a benchmark.

## 7. Decisions needed (3)

1. **How is the published orchestrator supported?** It is on the registry `[R]` and both READMEs deny it. The user has asked for a public installation path,
   so this is not a public-vs-internal question. *Recommended:* keep it published, documented as **advanced, opt-in — step 9, never step 1**, with macOS/Linux
   as declared targets and WSL2 as the documented Windows hint. Publication visibility and support level are separate concerns; **no unpublishing is implied
   or required.**
2. **What is the minimal base?** *Recommended:* commit to one and optionalize `deliberation`, **conditional on** §2's (a)–(c) consumer and dependency-closure
   proof, including the meta package's declared dependencies. Not a one-line manifest edit.
3. **Does `aigentry` become a delegating front door?** *Recommended:* yes (S2), delegation interface agreed first. The alternative — pointing all docs at
   `aigentry-devkit` — is cheaper and also closes the doc bug, but leaves the front door a status board whose own docs print commands it rejects.

No install, resolution, build, test, CI run, publication, release or runtime action was performed. Snyk N/A: documentation only, no first-party executable
change — this does not clear ecosystem security.
