# Fable-5 deep analysis — the 5 non-security aigentry repos

**Session**: `eco-fable-clean` (analyst, READ-ONLY) · **Model**: claude-fable-5 (held for the entire pass) · **Date**: 2026-07-05
**Scope**: aterm, dustcraw, amplify, logger, brain. Baseline: `docs/reports/2026-07-02-ecosystem-deep-analysis.md`. Security/permission surfaces out of scope (companion Opus pass owns them).

---

## 1. Executive summary

**The single highest-value structural improvement: archive `aigentry-dustcraw`.** One decision retires 21,077 tracked LOC (+972 untracked litter), and the evidence is unusually clean: zero code consumers anywhere in `~/projects` (no `import '@dmsdc-ai/aigentry-dustcraw'` exists; amplify defines its *own* `DustcrawContentCandidate` interface at `aigentry-amplify/packages/core/src/inbox/index.ts:23` and has never received a candidate), the promotion pipeline it exists to feed produced **zero output** (`~/.aigentry/dustcraw/signals/` is empty vs 3,535 raw items collected Mar 9–11), and the entire v0.4.0 feature set — decision-gate, enrichers, exporter, entitlement — never left the laptop (npm has only 0.3.1). Salvage the ~640-LOC core collector (`src/adapters/` + `RawStore` + `filters` + `SignalStore` + `BrainClientAdapter`) if a revival ever gets an owner; drop the rest. (FACT for the evidence; JUDGMENT for the verdict.)

The cross-repo pattern behind it (JUDGMENT, ecosystem-level): **product surface built ahead of any user**. Tier-gating with an upgrade URL in amplify (`packages/core/src/entitlement/index.ts:19-31`, 83L, private v0.0.1, 0 published posts) and dustcraw (`src/entitlement/index.ts:14`, 59L, unpublished features); a 3,072-LOC multi-AI "decision-gate" control plane inside an RSS collector (30% of dustcraw src); a 3,853-LOC nightshift-agent + Discord/Telegram messenger inside brain's memory engine, reachable only from the CLI, never from the MCP server. Roughly **9k LOC of speculative product scaffolding with zero external consumers** across these repos.

Positive delta worth naming (§13 balance): **the ecosystem reacted to the 07-02 baseline within 2 days** — aterm fixed the fake `status`, the stock README, and CON (commits 9869420/afcbc77/9953614, all 2026-07-04); brain dropped the `aigentry` bin collision and added LICENSE (c80808b/1734fb5, 2026-07-04). 6 of 12 baseline items verified FIXED. And logger is what right-sizing looks like: 578 src LOC, stdlib-only receiver, 33 behavior-level tests — the template the other repos should converge toward.

Totals if all recommendations land: **~24.8k lines removed** (2,794 high-confidence cuts + 22,049 dustcraw archive), **2 deps** (memoffset; ssot→devDep), **~538 MB disk** (aterm 390 MB untracked cruft, amplify 148 MB venv).

---

## 2. Delta table (baseline × status × evidence)

| # | Repo | Baseline item | Status | Evidence |
|---|------|---------------|--------|----------|
| 1 | aterm | `aterm new-session` subcommand doesn't exist (adapter falls back silently) | **STILL-OPEN** (aterm side) | grep `new-session|new_session|newSession` in `bin/aterm` (1,246L) + `bin/aterm.js` → 0 hits; adapter side = companion scope |
| 2 | aterm | Fake `aterm status` heredoc ("✅ installed" unconditionally) | **FIXED** | `bin/aterm:49` `print_ecosystem_status()` + `_probe_component` PATH probe; commit 9869420 (2026-07-04) |
| 3 | aterm | Stock Svelte README | **FIXED** | commit afcbc77 (2026-07-04); README now honest, states "pre-release 0.2.x, macOS Apple Silicon primary" |
| 4 | aterm | UNLICENSED metadata | **FIXED** | commit f941f52 (2026-05-24); `npm/aterm/package.json` license MIT |
| 5 | aterm | ~850 dead legacy lines (telepty.rs, mailbox delivery/notifier, FileMailbox, traits, MailboxConfig, bundle-server.js, bin/aterm.js, memoffset) | **STILL-OPEN, refined to ~830** | Dead confirmed: `aterm-core/src/telepty.rs` 188L (only ref `lib.rs:59`; live path is `telepty_bridge.rs`), `mailbox/delivery.rs` 142L + `notifier.rs` 16L (0 callers), `bin/aterm.js` 242L (orphan; published bin is `npm/aterm/bin/aterm.js`, a different 86L file), `scripts/bundle-server.js` 43L (Tauri-era, referenced by nothing), memoffset `aterm-core/Cargo.toml:22` (12 uses `lib.rs:827-838`; rustc 1.94 → `std::mem::offset_of!`). **One baseline claim REFUTED**: `FileMailbox`/`FileStorage` is LIVE (`inject.rs:8,278` → `pty.rs:14`, `app.rs:22`) — keep it |
| 6 | brain | `CON` tracked in git (breaks Windows clone) | **FIXED** (tracked) | `git ls-files CON` → empty; `.gitignore:17` guard. Untracked 49-byte leftover remains in the working dir (stray CLI echo) — local-only, delete-at-will |
| 7 | brain | `aigentry` bin-name collision | **FIXED** (brain side) | `package.json:22-26` now declares only `aigentry-brain-mcp`/`aigentry-brain`/`aigentry-brain-setup`; commit c80808b (2026-07-04). Orphan files survive — see B-2 |
| 8 | brain | `src/context/` duplicates dead `aigentry-context` engine | **STILL-OPEN, direction corrected** | 949L confirmed (`ContextPacker` 301, `ContextRestoreService` 386, `ContextBudgetPolicy` 213, `ConfidenceGuard` 49) but this is the **live** copy — wired via `src/index.ts:47-62`, consumed by `BrainContract.ts`, `policy/AutoCaptureEngine.ts`. Fix = archive the dead external repo, NOT cut brain |
| 9 | amplify | `private:true` v0.0.1 framework, 2 content pieces, built before audience | **STILL-OPEN, sharpened** | `package.json` still v0.0.1 private; `.content/` = 2 folders, **0 published** (one is a test fixture stuck `approved`; the 2026-04-01 folder is `source: amplify-manual` — hand-assembled, not framework-generated, still `draft`); dormant since 2026-04-01 (code since 2026-03-22) |
| 10 | logger | `logger-emit.js` copy-pasted into deliberation instead of shared dep | **PARTIAL** | Logger side done: published `@dmsdc-ai/aigentry-logger@0.2.0` (f4f62e3, 2026-06-06); brain consumes it as a real dep (brain e254626, "#520 step 3"). Deliberation-side consumption unverified — companion scope |
| 11 | dustcraw | Archive candidate (dormant-repo review) | **STILL-OPEN, evidence now decisive** | Last feature 9ce4032 (2026-03-19), last commit 58e4d72 (2026-04-01) = 108 days dormant; 0 consumers; empty `signals/`; v0.4.0 unpublished (npm at 0.3.1) |
| 12 | brain | `auto-deliberate.sh` deprecated (baseline noted the fork) | **STILL-OPEN, past deadline** | 30-day notice commit 9a36659 (2026-05-25) expired ~2026-06-24; file still tracked, 263L |

Score: **6 FIXED · 1 PARTIAL · 5 STILL-OPEN** (of which 2 refined/corrected against the baseline's own claims).

---

## 3. New findings per repo (severity-ranked, FACT/JUDGMENT tagged)

### 3.1 aterm

| Sev | Finding | Tag | Recommendation |
|-----|---------|-----|----------------|
| HIGH | **~390 MB of untracked working-tree cruft**: `vendor/winit-0.30.13/` = 289 MB (winit appears in NO Cargo.toml — pre-Swift iced/winit era leftover, carries its own `target/`), `docs/experiments/2026-05-10-cdylib-tokio-nesting-poc/` = 101 MB (two throwaway crates with committed-to-disk `target/debug/` dylibs). Neither is gitignored — one `git add .` from a repo disaster. FACT | delete: | `rm -rf` both, add `vendor/` + experiment `target/` to `.gitignore`; keep the POC's `report.md` |
| MED | **Platform-package wiring gap**: `npm/aterm/package.json` optionalDependencies lists ONLY `aterm-darwin-arm64@0.2.13`; `aterm-darwin-x64` and `aterm-linux-arm64` sit in-repo at stale **0.1.35**, unwired; no linux-x64 at all. On any non-arm64-Mac, `npm i -g @dmsdc-ai/aterm` installs a launcher that prints "native app bundle is not installed". README's "other platform builds in progress" makes this honest-but-confusing. FACT | shrink: | Either delete the two stale platform dirs or wire+rebuild them; don't ship 3-version-old ghosts |
| MED | **Three entry points named `aterm`**: `bin/aterm` (1,246L shell, the real CLI, copied into the .app by Makefile), `bin/aterm.js` (242L orphan legacy Node CLI), `npm/aterm/bin/aterm.js` (86L published launcher). FACT; confusing = JUDGMENT | delete: | Delete `bin/aterm.js`; document the other two's split in README |
| MED | **`aterm-core/tests/polling_event_tests.rs` (~140L) tests the stdlib, not the project**: every test re-implements a condvar wait loop inline (lines 47-70, 100-120) and calls zero aterm-core functions — would pass with all production code deleted. FACT | delete: | Delete or rewrite against real `aterm-core` APIs |
| LOW | **8 tracked `.tgz` pack artifacts** (`npm/aterm{,-darwin-arm64}/dmsdc-ai-*-0.1.0..0.1.3.tgz`) — binary blobs committed before the current `.tgz` gitignore rule. FACT | delete: | `git rm`; history rewrite optional |
| LOW | **Web-era leftovers still tracked**: `svelte.config.js`, `jsconfig.json`, `public/{favicon,icons}.svg`, `prototype/*.html` — the README was fixed but the stock files remain. ~50 session work-logs in `docs/reports/` (`rebuild-86..93`, per-publish notes); `docs/reports/2026-05-14-md-audit.md` already recommended cleanup — written, not acted on. FACT | delete: | Sweep in one hygiene commit |

**Strengths** (FACT): clean cbindgen FFI seam with layout assertions guarding the Rust↔Swift ABI (`lib.rs:827+`); legible single-purpose Makefile (rust→swift→metal→app, explicit codesign steps); the 3-crate split **earns its keep** — `aterm-session` as a thin shared types layer keeps `aterm-ipc` free of aterm-core's tokio/terminal stack (verified: real cross-crate use at `app.rs:17,93,490`). Do NOT collapse it.

### 3.2 brain

| Sev | Finding | Tag | Recommendation |
|-----|---------|-----|----------------|
| HIGH | **B-1 Nightshift-agent + messenger = a second product inside the memory engine** (3,853L): `src/agent/` 11 files 3,433L (`night/NightPolicy.ts` 494, `NightRunner` 298, `NightPlanner` 288, `SleepLearner` 283, `MorningReporter` 213…) + `src/messenger/` 420L (`DiscordBot.ts` 253, `TelegramBot.ts` 137). Reachable ONLY from `src/cli/braincli.ts`, never from the MCP server. FACT for wiring; "scope creep" = JUDGMENT | yagni: | Product call: extract to its own package or delete. Not a blind cut |
| HIGH | **B-2 Orphan "unified CLI" + README that tells users to run it** (309L): `bin/aigentry.mjs` not in package.json bin; `src/cli/aigentry.ts` (290L) imported by nothing — yet `README.md:41` says "To open the CLI dashboard: `aigentry`" and `README.md:118-120` documents `aigentry brain sync pull/push`. After `npm i -g`, that command does not exist. FACT | delete: | Delete both files + fix README (or wire the bin — but the collision fix c80808b just decided against a bare `aigentry` bin, so delete) |
| MED | **B-3 ML eval harness ships in the npm tarball** (1,018L): `src/experiments/` (`SearchEvalHarness.ts` 437 …) is inside the `files` whitelist (`src/` is shipped) and depends on untracked `artifacts/`+`datasets/` fixtures. FACT | yagni: | Move to dev-only path or exclude from `files` |
| MED | **B-4 Deprecation past deadline + tracked deliberation trio** (697L): `auto-deliberate.sh` 263L (30-day notice expired ~06-24), `deliberate.sh` 240L, `deliberation-monitor.sh` 176L, `mock_setup.js` 18L — tracked in a memory-engine package (deliberation repo owns this domain). FACT | delete: | Delete all four; the deprecation contract already promised it |
| LOW | **B-6 README tool count drift**: `README.md:71` says "MCP Tools (26)"; `src/mcp/BrainMcpServer.ts` registers 29 (missing the decision-commit linkage trio). FACT | shrink: | Regenerate the table |
| LOW | **B-5/B-7** Untracked junk (stray `CON` echo file, `__pycache__/deliberate.cpython-314.pyc` with **no .py source in repo**, empty nested `aigentry-brain/src/capture/` tree, 4 deliberation transcripts ~121KB); ~27 `BRAIN_*` env knobs incl. never-changing `BRAIN_SERVER_NAME`/`VERSION` (`src/shared/Config.ts:1-150`). FACT | delete:/shrink: | One hygiene sweep; prune config surface opportunistically |

**Strengths** (FACT): proper testability primitives (`shared/Clock.ts` Fake/System injection, `Mutex`, `AtomicWrite`) with ~1:1 test:src ratio (19.7kL:20.0kL); graceful-degradation MCP boot (`StubMcpServer.ts:216` keeps `brain_health` answering when bootstrap fails); **zero dead runtime deps** — all 9 imported, messenger hand-rolled on `ws`+fetch instead of pulling discord.js/telegraf; `files` whitelist keeps root clutter out of the tarball.

### 3.3 amplify

| Sev | Finding | Tag | Recommendation |
|-----|---------|-----|----------------|
| HIGH | **S1 Framework:output ratio = 1,020:1, published = ÷0**: 2,040 runtime LOC (core 1,030 + channels 596 + bin 414) for 2 content folders, 0 published. The framework encodes a 5-status state machine, plugin registry, retry/backoff, tier gates, inbox pipeline — and has never carried one real post to one real channel. FACT (measured); verdict = JUDGMENT | yagni: | Write the next 3 posts by hand; extract the framework from what actually repeats (N>3) |
| HIGH | **S1b Tier-gating with an upgrade URL on a zero-user private package** (83L): `packages/core/src/entitlement/index.ts:19-31` (`UPGRADE_URL` → aigentry.dev/upgrade), wired at `distributor.ts:45-56` to cap free tier to 1 channel. Commit e772765. FACT (existence/size only; mechanics companion-scope) | delete: | Delete until paying user #1 exists |
| MED | **S2 YouTube toolchain: 553L + 148 MB venv, invoked by nothing**: `scripts/youtube-*.{py,sh}` (Python + ffmpeg + venv, 3,321 files); YouTube isn't one of the 5 channels; zero references from `packages/` or `bin/`. FACT | delete: (relocate) | Move to its own repo/gist; it shares nothing with the framework |
| MED | **S3 Fictional monorepo boundary**: `packages/channels/src/*/index.ts:10-11` imports core via `"../../../core/src/types.js"` — bypassing the declared workspace dep; both packages point `main` at raw `src/index.ts` (no build artifact). The pnpm workspace buys zero isolation. FACT | shrink: | Collapse to one package; delete `pnpm-workspace.yaml` + 1 package.json + 1 tsconfig |
| MED | **S4 Hand-rolled YAML ×2** (~120L): regex parser `config.ts:5-58` + serializer/deserializer `manifest.ts:75-142` (JSON branch already exists at :102-104). Also 3 decorative config keys (`marketing.yml:22-27` — `twitter.handle`, `discord.channel`, `blog.output_dir`) that the parser never reads. FACT | stdlib:/shrink: | manifest→JSON (delete ~68L); config: add the `yaml` dep or trim the surface; delete the 3 dead keys |
| MED | **S6 `generate <type>` ignores its argument**: help advertises blog/social/all (`bin/aigentry-amplify.js:23`) but `cmdGenerate` only ever calls `generateBlogPost` (:150) and writes `blog.md` (:170). The headline "1 source → N channels" doesn't happen at generate time. FACT | shrink: | Implement or de-advertise |
| LOW | **S5 Three parallel template systems, only the inline one runs**: dead `transformer.ts` (54L, no caller, algorithm *differs* from the live per-plugin transforms), never-read `templates/*.md` (37L) and `presets/devtool/prompts/*.md` (47L), duplicate preset `marketing.yml` (31L). FACT | delete: | Keep the inline prompt; delete the rest (169L) |

**Strengths** (FACT): exceptionally lean deps — ONE runtime dep (`@anthropic-ai/sdk`); Twitter posting hand-built on `node:crypto`+fetch instead of two extra libs; correct right-sized retry with jitter+cap (`retry.ts:9-37`); 0.89:1 test ratio with dry-run paths throughout. The core is tight — the bloat is entirely in the surrounding layers.

### 3.4 logger

| Sev | Finding | Tag | Recommendation |
|-----|---------|-----|----------------|
| MED | **`--version` lies**: `src/cli.ts:14` and `src/index.ts:26` both hardcode `0.1.0`; package is 0.2.0. The test can't catch it (`test/cli.test.ts:44` asserts stdout equals the same constant). FACT | shrink: | Read version from package.json; delete both constants |
| MED | **ssot declared runtime, used type-only**: `package.json:44` puts `@dmsdc-ai/aigentry-ssot` in `dependencies`; every import is `import type` (`emit.ts:15`, `query.ts:8`, `receive.ts:10`, `index.ts:3-7`); README.md:8 itself says the coupling is type-only. Manifest contradicts README; every consumer install pulls ssot at runtime for zero runtime code. FACT | delete: | Move to devDependencies (−1 runtime dep) |
| MED | **Vendoring apparatus outlived its premise**: `schema.ts:2-9` justifies the vendored schema by an ssot exports-map limitation that the *published* ssot has fixed (`./schemas/v1/*.json` now exported); `scripts/check-schema-drift.mjs:13-18` checks against a filesystem sibling and silently `[skip]`s when absent — a no-op in the published-dep world. ~150L collapsible (vendored JSON 88 + copy-assets 32 + drift-check 32) **after** verifying the second stated reason (vitest `import.meta.resolve`). FACT for the premise-shift; cut = conditional | shrink: | Re-evaluate; repoint drift check at `node_modules/.../schemas/v1/` at minimum |
| LOW | **Doc/contract gaps**: CHANGELOG has no 0.2.0 entry and still describes the pre-0.2.0 `file:` wiring (`CHANGELOG.md:44-46`); README shows `await emit(event)` but emit is sync void (`emit.ts:39`); `AIGENTRY_LOGGER_DISABLED` documented as the global opt-out (`AGENTS.md:46`) but `emit()` reads no env — every consumer must reimplement the guard. FACT | shrink: | 0.2.0 changelog entry; fix README; one-line env guard in `emit()` to own the documented contract |
| LOW | Micro-dedup (~30L): `parseEmittedAt` byte-identical in `emit.ts:34-37`/`receive.ts:27-30`; persist tail duplicated `emit.ts:46-49`/`receive.ts:65-67`; `copy-assets.mjs` recursive walker for exactly 1 file. FACT | shrink: | Fold into `paths.ts`; one copyFileSync |

**Strengths** (FACT — the "disciplined MVP" label survives audit): no HTTP server/framework anywhere — receiver is `process.stdin`→`node:readline`, emit is `appendFileSync`, query is a file scan; 1 real runtime dep (ajv, justified: validates the canonical contract); 33 tests exercising real temp-dir behavior (rotation, sanitization, receive→query end-to-end), not mocks; dist untracked; clean subpath `exports`. **This repo is the reference point the other four should converge toward.**

### 3.5 dustcraw

| Sev | Finding | Tag | Recommendation |
|-----|---------|-----|----------------|
| HIGH | **`decision-gate/` = 3,072L, 30% of src, a control plane inside a collector**: 24 files (LLMProvider 299, DefaultDecisionGate 283, mcp-client 247, state-store 210, 8 prompt templates…) — a self-amplifying multi-AI governance layer for a personal RSS absorber, and it never shipped (npm=0.3.1 predates it—verify: it's in the unpublished set). FACT for size/wiring; JUDGMENT on fit | yagni: | Falls with the archive decision; if kept, this is cut #1 |
| HIGH | **The loop never closed**: `~/.aigentry/dustcraw/signals/` = 0 files vs `raw/2026-03-11.jsonl` = 2.4 MB / 3,535 items. The SignalStore→Brain→amplify pipeline (export/ 100L, registry/ 263L + P0/P1/P2 commits) produced zero promoted output; ran Mar 9–11, then stopped. FACT | — | This is the archive-decision clincher |
| MED | **`handoff/` (852L) architecturally misplaced**: TeleptyListener/InboxManager/SynthesisConsumer — a cross-project deliberation-handoff daemon inside a "signal absorber"; reads mcp-deliberation state files. FACT placement; JUDGMENT on belonging | delete:/relocate | Falls with archive; belongs in the deliberation/orchestration domain if ever revived |
| MED | **v0.4.0 never published**: npm view = 0.3.1; everything after 271b49d (Mar 18) — 4-phase tick, Express Mode, ImageOCR/AudioTranscript enrichers (187L speculative multimodal for a text collector), exporter, entitlement — is laptop-only. FACT | — | Confirms zero external blast radius for archiving |
| LOW | **Root litter, all untracked** (972L): 8 abandoned report .md (658L) + 4 one-off fix scripts (314L) + 3 .DS_Store + a stray log. `deploy/dustcraw.service` targets generic `/opt/dustcraw`; no launchd plist exists despite the "systemd/launchd" commit — real execution was local, never a service. FACT | delete: | `rm`, nothing tracked is lost |

**Strengths** (FACT): the core collect→store loop genuinely ran on real data (one of the few non-aspirational tools here); `BrainClientAdapter` (147L) is a clean isolation seam; 0.81 test:src ratio (8,162 test LOC). Salvage-worthy core ≈ 640L.

---

## 4. Over-engineering cut list (ponytail ladder)

**aterm** — `net: -830 lines, -1 dep, -390 MB disk`
- delete: `aterm-core/src/telepty.rs` (188) — dead twin of live `telepty_bridge.rs`
- delete: `aterm-core/src/mailbox/delivery.rs` (142) + `notifier.rs` (16) — zero callers
- delete: `bin/aterm.js` (242) — orphan legacy CLI · `scripts/bundle-server.js` (43) — Tauri orphan
- delete: `aterm-core/tests/polling_event_tests.rs` (~140) — tests std::sync::Condvar, not aterm
- yagni:/shrink: collapse one-impl traits `MailboxStorage`/`Locker`/`LockGuard`/`Notifier` + always-default `MailboxConfig` (~60)
- stdlib: memoffset → `std::mem::offset_of!` (12 sites, `lib.rs:827-838`; rustc 1.94)
- delete: (disk) `vendor/winit-0.30.13` 289 MB + POC `target/` 101 MB; (history) 8 `.tgz` blobs; (hygiene) web-era files + ~50 report work-logs
- KEEP: 3-crate split, FileMailbox/FileStorage (live), `bin/aterm` shell CLI

**brain** — `net: -1,006 lines now, -0 deps; -4,871 more on product call`
- delete: orphan CLI `bin/aigentry.mjs` + `src/cli/aigentry.ts` (309) + README fix
- delete: `auto-deliberate.sh` (263, deprecation expired) + `deliberate.sh` (240) + `deliberation-monitor.sh` (176) + `mock_setup.js` (18)
- yagni: (product call) `src/agent/` + `src/messenger/` (3,853) — CLI-only second product
- yagni: (product call) `src/experiments/` (1,018) out of the shipped tarball
- delete: (hygiene) stray `CON`, orphan `.pyc`, empty nested tree, 4 transcripts
- KEEP: all 9 runtime deps (all used), context/ (live engine), test suite

**amplify** — `net: -925 lines (-372 delete, -553 relocate), -0 deps, -148 MB`
- delete: (relocate) `scripts/` YouTube toolchain (553 + 148 MB venv) — invoked by nothing
- stdlib:/shrink: hand-rolled YAML ×2 (~120): manifest→JSON via existing branch; config → `yaml` dep or trimmed surface
- delete: `entitlement/` (83) · dead `transformer.ts` (54) · `presets/devtool/prompts/` (47) · `templates/` (37) · dup preset yml (31)
- shrink: collapse pnpm workspace → 1 package (boundary already fictional); delete 3 dead `marketing.yml` keys; fix `generate <type>` no-op
- KEEP: plugin core, retry, state machine, the 1-dep discipline

**logger** — `net: -33 lines now (~-183 conditional), -1 runtime dep`
- shrink: single-source version from package.json (~2, fixes the `--version` bug)
- delete: ssot `dependencies` → `devDependencies`
- shrink: dedup `parseEmittedAt` + persist tail (~10) · copy-assets walker → one copyFileSync (~20) · optional `makeEmitter` (3)
- shrink: (conditional) vendored schema + 2 scripts (~150) if sourcing schemas from published ssot survives the vitest check
- KEEP: everything else — this is the reference repo

**dustcraw** — `net (archive): -21,077 tracked -972 untracked lines, -1 npm package; net (de-scope): -4,849 src (48%) + tests`
- delete: (archive-preferred) whole repo; salvage `adapters/`+`RawStore`+`filters`+`SignalStore`+`BrainClientAdapter` (~640)
- if kept: decision-gate 3,072 · handoff 852 · registry 263 · enrichment 187 · StrategyOptimizer 254 · export 100 · CompositeMetric 62 · entitlement 59

**Grand total: ~24.8k lines, -2 deps, ~538 MB disk.**

---

## 5. Prioritized actions (top 5)

| # | Action | Effort | Exact files |
|---|--------|--------|-------------|
| 1 | **Archive dustcraw** (orchestrator decision; salvage note in the archive commit) | **S** (decision) | whole repo; salvage list §3.5; downstream: 2 devkit manifest entries (`installer-manifest.json:158`, `dustcraw.adapter.json:27`) — devkit is companion scope, flag it there |
| 2 | **aterm dead-code + disk sweep** (~830L, 1 dep, 390 MB) | **S** | `aterm-core/src/telepty.rs`, `aterm-core/src/mailbox/{delivery,notifier}.rs`, `bin/aterm.js`, `scripts/bundle-server.js`, `aterm-core/tests/polling_event_tests.rs`, `aterm-core/Cargo.toml:22` (memoffset→std), `rm -rf vendor/winit-0.30.13 docs/experiments/2026-05-10-*/{host,dummy-supervisor}/target`, `.gitignore` |
| 3 | **brain hygiene batch** (~1,006L + README truth) | **S** | `bin/aigentry.mjs`, `src/cli/aigentry.ts`, `README.md:41,71,118-120`, `auto-deliberate.sh`, `deliberate.sh`, `deliberation-monitor.sh`, `mock_setup.js`, untracked `CON`/`__pycache__`/`aigentry-brain/` |
| 4 | **amplify de-scope** (~925L, 148 MB, honesty fixes) | **M** | `scripts/` (relocate), `packages/core/src/entitlement/index.ts`, `packages/core/src/content-engine/transformer.ts`, `templates/`, `presets/devtool/`, `packages/core/src/workflow/manifest.ts:75-142`, `packages/core/src/config.ts:5-58`, `marketing.yml:22-27`, `bin/aigentry-amplify.js:120-176`, `pnpm-workspace.yaml` |
| 5 | **logger accuracy pass** (~33L, −1 runtime dep) | **S** | `src/cli.ts:14`, `src/index.ts:26`, `package.json:44` (ssot→dev), `CHANGELOG.md` (0.2.0 entry), `README.md:44-46`, `src/emit.ts` (env-guard decision + dedup) |

Larger product calls deliberately NOT in the top 5 (they need an owner decision, not a cleanup PR): brain's agent/messenger extraction (3,853L), amplify's "framework vs hand-written content" pivot (S1).

---

## 6. Method & self-critique

**Method.** Read the baseline report's sections for these 5 repos; verified every baseline item directly (git log/ls-files, grep, wc -l, package.json inspection); fanned out 5 parallel read-only Explore subagents (one per repo) with security topics explicitly excluded from their briefs; cross-checked their load-bearing claims (line counts, npm wiring, commit hashes) against my own direct measurements where they overlapped — no contradictions found. Zero files modified; zero builds/tests run (READ-ONLY contract). No Snyk scan: no code was generated or modified (scan trigger is inapplicable to a read-only analysis).

**What I read**: all 5 repos' structure, entry points, package manifests, the specific files cited above. **What I did NOT read**: orchestrator/telepty/deliberation/devkit/registry internals (companion scope) — hence delta #10 is PARTIAL, not FIXED, and the `aterm new-session` adapter side is unverified; anything security-adjacent in any repo (out of scope by dispatch; one line applies: security aspect out of scope — companion Opus pass owns it).

**Confidence.** HIGH on all FACT-tagged items (each has file:line or commit evidence, most double-verified). MEDIUM on the conditional logger vendoring cut (one unverified premise: vitest `import.meta.resolve` — flagged, not asserted). The archive-dustcraw verdict and all yagni: product calls are JUDGMENT — evidence-backed but reversible decisions that belong to the orchestrator/operator, and I've kept them out of the mechanical top-5 where they need a human call.

**Known inference risks**: (1) "zero callers" greps for the aterm dead files can't see callers outside `~/projects` — but these are `pub mod` surfaces in a repo with no external consumers, so residual risk is low; per dispatch discipline I checked that none of the cut candidates traces to a numbered ADR/issue as a planned capability (the only such case found was the reverse: brain's auto-deliberate deprecation #462 *mandates* deletion). (2) dustcraw's npm 0.3.1 downloads-vs-usage wasn't measurable locally; "zero consumers" is a code-level claim, not a telemetry claim. (3) Line counts are `wc -l`, so comments/blanks inflate absolute numbers uniformly — ratios and rankings unaffected.
