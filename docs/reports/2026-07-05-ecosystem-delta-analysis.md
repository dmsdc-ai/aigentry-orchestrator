# aigentry Ecosystem — Delta + New-Findings Analysis (Fable 5)

- **Date**: 2026-07-05
- **Author**: `eco-fable5`, role = analyst — **READ-ONLY** (this report is the only artifact)
- **Baseline**: `docs/reports/2026-07-02-ecosystem-deep-analysis.md` (2026-07-02). This pass verifies each baseline finding's current state and adds NEW findings.
- **Scope (this session)**: FOUR dimensions — Structural · Over-engineering · Usability · Business. **Security is out of this session's scope** (handled separately by the orchestrator to keep this analysis on Fable 5). Where a baseline item had a security angle, only its *structural* aspect is noted here.
- **Stance** (Constitution §13): critical + constructive + objective. Every risk carries a recommendation; strengths noted; claims marked FACT vs JUDGMENT.
- **Method**: every delta re-verified by direct read (`git log`, `grep`, `sed -n`, `wc`) at 2026-07-05 plus two parallel cross-repo sweeps; conflicts between sources were resolved by direct read and are flagged in §5.

---

## 1. Executive summary

**The ecosystem moved almost entirely on hygiene, not strategy or structure, in the 3 days since baseline.** Only three repos changed: telepty (CI deflake + license alignment + 0.6.7), the `aigentry` hub (one dependency-manifest commit), and deliberation (dead-code cleanup). **The orchestrator — where the heaviest structural findings live — has not been committed since 2026-06-22**, so every orchestrator-side baseline finding (dormant TS kernel, model-default drift, 519-line rulebook) is STILL-OPEN by construction. (FACT.)

The team's *own* housekeeping is genuinely good this window, and worth crediting: a self-labeled "ponytail audit" deleted ~939 lines of dead CDP scripts, the `aterm` Windows-clone-breaking `CON` file and fake `status` heredoc and stock README are all fixed, telepty is MIT-aligned with green CI, and the meta package's stale pins are bumped. (FACT.)

**But the celebrated front-door fixes are source-only, not delivered.** The `aigentry` bin-collision and the meta-package pins were fixed *in git* — yet the published npm artifacts a stranger actually installs today still collide, because `devkit`/`brain` were never republished (and `devkit`'s version is stuck at an already-published `0.0.21`, so it *can't* republish without a bump the team's own task note doesn't capture). So `npm i -g @dmsdc-ai/aigentry` is still broken at the front door — the fix exists but no user can get it. (FACT, cross-verified via `npm view`.)

Two deeper levers remain frozen. **Structurally**, ~1,726 LOC (≈50%) of the orchestrator's `src/` TS is production-dormant — a fully-built, tested kernel that nothing calls — unchanged. **Commercially**, the human-only monetization gate (`#596` pre-sell) has now sat `awaiting-user` for 3+ weeks with no ADR written; that silence is the de-facto decision, and positioning, `entitlement.js` gating, and licensing all wait on it.

**The single most important thing to do now** is to force the `#596` decision — run the 14-day pre-sell or write a one-paragraph "monetization paused" ADR — because it is the one step no agent can perform and it blocks the entire positioning/pricing/license chain. The highest-leverage *mechanical* fix in parallel is to **actually publish** the already-committed collision/pin fixes (bump `devkit`, re-pin the hub), so the front-door repair reaches a real user instead of sitting in git.

---

## 2. Delta table — baseline headline findings × current state

Legend: **STILL-OPEN** / **FIXED** / **PARTIAL** / **REGRESSED**. (Security-category baseline items are out of this session's scope — see §6 stub.)

| # | Baseline finding | Verdict | Evidence (2026-07-05) |
|---|---|---|---|
| S1 | ~52% of `src/` TS is production-dormant (gate/validate/permission/persistence, zero prod callers) | **STILL-OPEN** | 1,726 / 3,426 LOC dormant; `bin/` "callers" are false-positives on the English word *gate* (`session-cleanup.sh:45`, `workspace-host.sh:197`) |
| S2 | Model-default drift: `boot-prepare.mjs` missing `[1m]` suffix | **STILL-OPEN** | `boot-prepare.mjs:607` still `"claude-opus-4-8"` vs `dispatch.sh:61` / `open-session.sh:136` `claude-opus-4-8[1m]` |
| S3 | Cross-repo role duplication (brain↔context, deliberation `lib/telepty.js`, copied `logger-emit.js`) | **STILL-OPEN / worsened** | brain `src/context/` (4 files) vs dead `aigentry-context` (last commit 2026-04-07); `deliberation/lib/telepty.js` = 911 LOC; **`logger-emit` is now TWO divergent copies** — `deliberation/logger-emit.js` (ESM) + `devkit/lib/logger-emit.js` (CJS), both bridging a logger pkg they already depend on |
| S4 | `aigentry` global-bin collision (hub / devkit / brain) | **PARTIAL (source-fixed, not delivered)** | Local source: only hub declares bin `aigentry`. **But published `devkit@0.0.21` + `brain@0.2.7` still declare `aigentry`** (`npm view`), and the hub pins those exact versions → a real `npm i -g` still collides |
| S5 | Governance over-engineering (rules.md 519 lines, 28 HARD rules, 150-line Rule 4-A) | **STILL-OPEN** | `docs/rules.md` still 519 lines; orchestrator unchanged since 2026-06-22 |
| S6 | Dead code / cruft (cmux-inject.sh, *.bak, agy/grok logs, 17MB tracked `state/`) | **PARTIAL** | `state/` now only 2 files tracked (bulk untracked) = FIXED; but `bin/cmux-inject.sh` + `AGENTS.md.pre-slim.*.bak` still tracked = STILL-OPEN |
| U1 | Meta package: stale pins + shim installs nothing | **PARTIAL** | Pins bumped in source (`3752170`); but `bin/aigentry.js` (88 LOC) is still a `status\|version\|help` shim that installs nothing (`:57` tells the user to re-run `npm i -g`), and the pin fix is unpublished (see S4) |
| U2 | `aterm new-session` adapter calls a nonexistent subcommand | **STILL-OPEN (now ticketed #644)** | `workspace-host.sh:727` still calls `aterm new-session …` with silent `2>/dev/null`; the correct target `aterm create` **does exist** (`aterm/bin/aterm:665`) → #644 is a viable one-liner |
| U3 | Fake `aterm status` heredoc (unconditional "installed") | **FIXED (status) / PARTIAL (help)** | `aterm status` now probes via `command -v` (`9869420`, bilingual); but `aterm help` still hardcodes "✅ … installed" (`bin/aterm:110-113`, `:199-201`) |
| U4 | `CON` file breaks Windows clone | **FIXED** | The tracked clone-breaker (aterm) removed + gitignored (`9953614`); brain's `CON` is **untracked** (never broke clone) but lacks a `.gitignore` guard |
| U5 | Korean-only governance unoperable by non-authors | **STILL-OPEN** | rules.md/constitution unchanged; note `aterm` status/help are now bilingual (small improvement) |
| B1 | Positioning fractured; hub docs frozen in March "3-pillar" vision | **STILL-OPEN** | `aigentry/README.md:5` still "Sovereign Brain OS"; `architecture.md` frozen 2026-03-02 |
| B2 | Wedge stalled at `#596` pre-sell (human-only step) | **STILL-OPEN** | `state/task-queue.json:6365` `#596` = `awaiting-user`; `#595`/`#598` = `awaiting-user-adoption` |
| B3 | `entitlement.js` gates with no purchase path; can `exit(1)` headline feature | **STILL-OPEN** | `entitlement.js` (70 LOC) only *reads* `~/.aigentry/license.json`; no issuance path; `cli.js:2391/2552` `exit(1)` on free tier |
| B4 | License mess (MIT/ISC mismatch, missing files, UNLICENSED aterm) | **PARTIAL** | telepty MIT-aligned (`60d3918`) + brain MIT (file+pkg, `1734fb5`) = FIXED; **orchestrator still `UNLICENSED` + no LICENSE file**; amplify/dustcraw declare MIT but have no LICENSE file; aterm has a MIT file but no `license` field in package.json |
| B5 | Distribution = 0 (Show HN/GN drafts never posted; amplify pre-audience) | **PARTIAL** | NEW task `#643` "[telepty] GeekNews (Show GN) 공개" created 2026-07-04, front-door prereq now `done` — but **not yet posted** |
| B6 | No moat; herdr ahead; self-negating market research | **STILL-OPEN** | No new market/strategy report since baseline (newest in `docs/reports/` is the 2026-07-02 baseline itself) |

**Changed-since-baseline items the dispatch flagged — verified:**
- Meta pins bumped + manifest tracked (`3752170`) → **confirmed in source** (U1/S4 PARTIAL — undelivered).
- deliberation CDP graveyard deleted (`13e7184`, self-labeled "ponytail audit", −939 lines, vitest 236 still pass) → **confirmed FIXED**.
- telepty MIT license aligned, 0.6.7 published, CI flakes fixed + green-gate → **confirmed FIXED**.
- Terminal adapters audited-and-KEPT (#494/#608) → **honored; not re-recommended for deletion.**

---

## 3. New findings (not in the baseline)

### 3.1 Structural

- **[HIGH · FACT] The bin-collision & pin fixes are committed but not published — every real install still collides.** Source is clean (hub sole owner of `aigentry`), but `npm view` shows `devkit@0.0.21` and `brain@0.2.7` still declare the `aigentry` bin, and the hub pins those exact published versions. The fix cannot reach a user until `devkit`/`brain` republish. **Rec:** publish the fixed `brain`/`devkit`, then confirm the hub resolves them (S).
- **[HIGH · FACT] `devkit`'s bin fix is unshippable without a version bump.** The fix left `devkit` at `0.0.21` — identical to the published version — so it can't be republished as-is, and the hub's `^0.0.21` is a 0.0.x **exact-lock** that won't accept a `0.0.22` either. The team's task note (`state/task-queue.json:6982`) treats publish as a simple "user gate" and misses this. **Rec:** bump `devkit` → `0.0.22` **and** re-pin the hub to `^0.0.22` (S).
- **[MED · FACT+JUDGMENT] Two of the five meta pins are 0.0.x exact-locks.** `^0.0.21` (devkit) and `^0.0.47` (deliberation) in `aigentry/package.json` can never receive a patch fix without a manual hub re-pin+republish — structural fragility on 40% of the meta deps. **Rec:** graduate devkit/deliberation to `0.x.y` semantics (S–M).
- **[MED · FACT+JUDGMENT] `logger-emit` has become two divergent hand-maintained bridges** — `deliberation/logger-emit.js` (ESM, 119 L) and `devkit/lib/logger-emit.js` (CJS, 119 L, different event maps) — both bridging `@dmsdc-ai/aigentry-logger`, which both already depend on. Baseline flagged only the deliberation copy; devkit's has since diverged. Traces to a deliberate phased design (#440), so **not accidental slop** — but the shared dynamic-import-with-degradation core (~50%) belongs in the logger package as a subpath export. **Rec:** ship the bridge from `aigentry-logger`; delete both local copies (M).
- **[MED · FACT] The orchestrator is frozen while its satellites move — a version-desync risk.** Orchestrator last commit `caac403` = 2026-06-22; meanwhile telepty went 0.6.2→0.6.7 changing wire semantics (readiness gate, inject consumption-evidence) the orchestrator's shell layer pins against. Nothing broke yet, but there is no telepty-version floor check. **Rec:** add a one-line `telepty --version` floor assertion in dispatch/boot preflight (S).
- **[LOW · FACT] `daemon.js` is a 4,452-LOC god-module** (telepty) — but tracked as `#495`, so per ladder discipline this is a known refactor target, **not a blind cut**. **Rec:** keep #495; land new routes in `src/` modules rather than appending.
- **[LOW · FACT] `aigentry-context` is fully dead** (2 commits, last 2026-04-07) while its logic lives forked in `brain/src/context/`. Clearest archive candidate in the ecosystem. **Rec:** archive the repo (brain absorbed it) — repo-level deletion, not a code change (S).

### 3.2 Over-engineering (ponytail ladder)

- **[MED · JUDGMENT] The dormant ~1,726-LOC TS kernel is speculative weight built ahead of its wiring** — correct, tested, zero callers. **Ladder check:** it traces to a documented capability (the orchestrator AGENTS.md WIRING-GAP note), so it is a *planned* layer, not blind speculation; do **not** silently cut it. **Rec:** force a binary decision — wire it (warn-mode first) or park it in `archive/` with a dated note. Inert-but-shipped is the one state the ladder forbids (S to decide / M to wire).
- **[MED · JUDGMENT] `entitlement.js` + its gates are open-core machinery shipped ahead of the strategy that justifies it** — 70 LOC of gate, two `exit(1)` sites, an `UPGRADE_URL` constant pointing at a page with no backend, all built while `#596` is unmade. Feature for a customer who doesn't exist yet. **Rec:** until an issuance path exists, make the gate non-fatal (warn, not `exit`) or default `remote_sessions` to free (S).
- **[MED · JUDGMENT] Rule 4-A is still ~150 lines of frozen-experiment statistics** (TOST p-values, Welch/Cohen, B1–B6 lattice) an LLM operator must consult before delegating — asking for determinism a sampled model can't give. **Rec:** mechanize to a ~30-line `bin/select-mode.sh`; the rulebook cites the script (M).
- **[STRENGTH · FACT] The team is running its own ponytail audits and deletion discipline.** `13e7184` ("remove dead CDP diagnostic scripts (ponytail audit)"), the `CON` removal, and the `state/` untracking are exactly the Article-1 deletion-over-addition behavior the constitution asks for. Verified non-cuts: deliberation's large files (`browser-control-port.js` 1198 L, `model-router.js`, `selectors/*`) are all wired, tested, and in `files` — **not** speculative.

### 3.3 Usability

- **[HIGH · FACT] `install.ps1` is ~3 months / ~500 lines behind `install.sh`; Windows cannot install the orchestrator profile.** `install.ps1` (499 L, last touched 2026-03-18) never received `#518 setup --profile orchestrator` (+197 L): "orchestrator" appears **27× in install.sh, 0× in install.ps1**. Windows users silently get no orchestrator. **Rec:** port #518/#521/#613-614 to `install.ps1`, or document Windows-orchestrator as explicitly unsupported (M).
- **[MED · FACT] The meta "one command" still doesn't put the sub-tools on PATH** (even once the pin/collision fixes ship). `npm i -g @dmsdc-ai/aigentry` links only the top-level `aigentry` bin; `telepty`/`aterm` bins aren't exposed, and `bin/aigentry.js` installs nothing — it prints status. A stranger who runs the advertised command (`README.md:21`) gets a status shim. **Rec:** make `bin/aigentry.js` shell out to the devkit installer, or retract the "one command installs everything" claim and point at devkit (S–M).
- **[LOW · FACT] `aterm help` still lies where `aterm status` was fixed** — `show_help()` hardcodes "✅ brain/telepty/deliberation/devkit — installed" (`bin/aterm:110-113` KO, `:199-201` EN), which unlike `status` can't tell truth from fiction. **Rec:** delete the hardcoded "Ecosystem" block from `show_help()` (it duplicates `status`) (S).
- **[LOW · FACT] brain's untracked `CON` lacks the `.gitignore` guard aterm added** — harmless today (untracked) but one `git add` from re-introducing the Windows-clone breaker. **Rec:** add `CON` to `aigentry-brain/.gitignore` (S).

### 3.4 Business

- **[HIGH · FACT] The delta window confirms the wedge is human-blocked, not tech-blocked.** In 3 days: 6 telepty hygiene/CI commits, 1 hub manifest commit, 1 deliberation cleanup — zero on positioning, ADR, or monetization; `#596`/`#598` remain `awaiting-user`. **Rec:** treat 3+ weeks of `awaiting-user` as the decision it already is — schedule the pre-sell or write a one-paragraph "monetization paused" ADR and close `#598` (S, human).
- **[MED · FACT] `entitlement.js` is a self-inflicted adoption blocker on the headline feature.** A default `free`-tier install running cross-machine — the flagship demo — hits `exit(1)` (`cli.js:2391`) with no way to buy out (no issuance path). **Rec:** default `telepty.remote_sessions` to free, or downgrade the gate to a warning, until a real purchase path exists (S).
- **[MED · FACT] Distribution finally has a concrete task but it is unshipped.** `#643` (Show GN) created 2026-07-04, UX prerequisite cleared — the first forward motion on the "no audience" gap. **Rec:** ship `#643` this week; it is a zero-code distribution test that de-risks monetization before any pricing work (S, human).
- **[MED · FACT] License hygiene is improving but the *control tower* is still fully unlicensed.** telepty + brain are clean MIT; but `aigentry-orchestrator` has no LICENSE file and `package.json` says `UNLICENSED`, and amplify/dustcraw declare MIT without a LICENSE file. **Rec:** add MIT LICENSE files to orchestrator/amplify/dustcraw and set orchestrator's `package.json` license (10-min fix); `UNLICENSED` on the orchestrator blocks any external trust/contribution (S).

---

## 4. Prioritized action list (top 7, all dimensions)

| # | Action | Dim | Effort | Files |
|---|---|---|---|---|
| 1 | **Decide `#596`**: run the 14-day pre-sell or write a "monetization paused" ADR and close `#598` | Business | S (human) | `state/task-queue.json`, new `docs/adr/2026-07-0x-monetization-*.md` |
| 2 | **Actually publish the front-door fix**: bump `devkit` → 0.0.22, republish `brain`/`devkit`, re-pin hub off the 0.0.x exact-locks | Structural / Usability | S | `aigentry-devkit/package.json`, `aigentry-brain/package.json`, `aigentry/package.json` |
| 3 | **Wire-or-delete the dormant ~1,726-LOC TS kernel** (warn-mode wire, or park in `archive/`) | Structural / Over-eng | S decide / M wire | `src/session/validate-spawn.ts`, `src/gate/*`, `bin/boot-prepare.mjs` |
| 4 | **Stop `entitlement.js` breaking the headline demo** — default `remote_sessions` free or warn-not-exit | Business / Over-eng | S | `aigentry-telepty/entitlement.js`, `cli.js:2391,2552` |
| 5 | **Port `install.ps1` to parity** (orchestrator profile, #518/#521/#613-614) or mark Windows-orchestrator unsupported | Usability | M | `aigentry-devkit/install.ps1` |
| 6 | **Single-source the CLI default flags** to kill the `[1m]` model drift | Structural | S | `bin/boot-prepare.mjs:607`, `bin/dispatch.sh:61`, `bin/open-session.sh:136` |
| 7 | **License the control tower + fix the `aterm` adapter** — MIT files for orchestrator/amplify/dustcraw; repoint `aterm new-session`→existing `aterm create` (#644); drop the hardcoded "installed" help block | Business / Usability | S | `LICENSE` (×3), `orchestrator/package.json`, `workspace-host.sh:727`, `aterm/bin/aterm:110-113,665` |

---

## 5. Method & self-critique

- **What I read directly** (FACT-confidence): telepty `package.json`/`LICENSE`/`CHANGELOG`/`daemon.js`/`cli.js`/`entitlement.js`; orchestrator `boot-prepare.mjs`/`workspace-host.sh`/`session-cleanup.sh`/`docs/rules.md`/`docs/adr/`/`state/task-queue.json`/`git log`; hub `package.json`/`bin/aigentry.js`/`README.md`; brain `src/context/`/git/LICENSE; deliberation `inbox-watcher.mjs`/`lib/telepty.js`/git; aterm `bin/aterm`/`package.json`; context/amplify/dustcraw git+license. Two parallel cross-repo sweeps (structural/usability, business) supplied the `npm view` published-artifact check and the `install.ps1` diff.
- **Delta table** is fully verified at 2026-07-05, not inherited.
- **Conflicts I resolved by direct read** (§13): (1) a business sweep reported brain as "UNLICENSED, no LICENSE file" — my direct check contradicts it (brain has a MIT `LICENSE` file *and* `package.json` MIT → FIXED); I used the direct reading. (2) The baseline attributed the tracked `CON` to brain; current state shows the tracked breaker was aterm's (now removed) and brain's `CON` is untracked — I represent the FIXED reality, not the baseline's attribution.
- **Confidence is lower** on: the published-artifact collision (S4/§3.1) — cross-verified via `npm view` by a sub-agent, not by me re-running it, though it is consistent with the unpublished local commits I did read; and on U1 PATH-linking (inferred from npm's top-level-bin-only linking + the shim's content, not from an actual `npm i -g`, which is out of read-only scope).
- **What I did NOT do**: run any build/test/daemon, execute anything, read `syc-ai`/confidential task data, or re-derive the baseline's threat model.
- **Framing caution**: this session's scope was deliberately narrowed to four non-security dimensions; the baseline's highest-severity risks are security-category and are **not** re-ranked here.

---

## 6. Security

Security delta handled by the orchestrator (out of this session's scope, to keep the model on Fable 5). See baseline `docs/reports/2026-07-02-ecosystem-deep-analysis.md §2` for the standing threat model; the structural aspect of the gate kernel (≈50% dormant TS, zero callers) is captured in §2 (S1) and §3.1–3.2 above without security framing.

---

*Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>*
