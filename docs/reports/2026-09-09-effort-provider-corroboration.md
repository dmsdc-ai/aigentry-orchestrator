# E7-provider corroboration: CLI effort surface vs official docs (task #1148)

- **Kind**: primary-doc corroboration of E7-local capture. Not production code, not approved capability metadata, not a routing/default-policy decision.
- **Fetched (UTC)**: 2026-09-09T14:00:09Z–14:25:00Z (public GET only; no login, no live model lists, no CLI re-run). Original author `pd1148-dustcraw`. **This session did not re-fetch S1–S17.**
- **Original author session**: `pd1148-dustcraw` (researcher). Original worktree `/Users/duckyoungkim/.aigentry/worktrees/pd1148`, branch `evidence/1148-provider-capabilities`. Original start HEAD `f509ed8db835a667e007570900132f63fabe2bb6` (`docs(1148): E7-local effort/model capability capture`); original note that local `main` was then identical (`0 0`).
- **Original `origin/main` note (historical, not current remote)**: `a536cd8b303f6781ccccc9f4817aa8a6c0416845` (2026-08-30). Original author counted `a536cd8..9eac5b3` = **203** commits and marked capture report’s “2030” as a digit error. **203 is that previously corrected historical count; it is not this session’s remote state.**
- **Correction (UTC)**: 2026-09-10T11:32:40Z sample; wording-only. Session `pd1148b-dustcraw`. Worktree `/Users/duckyoungkim/.aigentry/worktrees/pd1148b`, branch `evidence/1148-provider-review`. No new GET, no installed-CLI re-run, no model calls.
- **Correction start HEAD**: `9ce3af51c9b4d91ce1169c12d8401f5438b2ae71` (`docs(1148): corroborate effort capabilities with primary sources`, 2026-09-10 00:14:44 +0900). Report blob before this edit: `262aa553d302e5713438036078c988ec26b861e9`.
- **This-worktree currentness (2026-09-10T11:32:40Z, no fetch)**: local `main` `34584ff5cbf42350db3e7f4a5d551acba966cb40` (2026-09-10 20:31:06 +0900). `origin/main` tracking ref still `a536cd8…` (2026-08-30); not a fresh remote. Merge-base `HEAD`/`main` = `f509ed8…`. `9ce3af5` is **not** an ancestor of this local `main`. Named corroboration file **absent** on local `main` and on `origin/main`. Capture file **same blob** on this HEAD and local `main`.
- **Local evidence (read-only)**: `docs/reports/2026-09-09-effort-capability-capture.md` (blob `7ecb880ac60405997b187caad0f41cf925aef5e8`; original commit `ad477d87` retained on this `main`). Observed historical versions in that capture: claude 2.1.266, codex 0.153.4, grok 1.0.24, agy 1.1.28, gemini 0.53.0 — not a re-run and not proof of today’s live environment.
- **Snyk / build / test**: N/A.

## 0. Limits

Official pages prove **documented vocabulary**, not runtime honouring, account availability, or cost/quality. A docs fetch that succeeds for a later CLI/docs revision does **not** prove the installed binary. Unknown is not unsupported. No `provider_applied=true`. No machine capability metadata is approved here.

Three layers are kept separate. Same words across layers are **not** translation proof:

1. **Generic API vocab** (provider HTTP/SDK).
2. **CLI translation** (flag/config key/slug the binary accepts).
3. **Model-specific support** (named model on that API/CLI).

A candidate **both** row means local E7-local surface and a fetched official page name the same tuple/surface **on the compared layer**. Runtime remains unmeasured. Cross-layer mapping is **unknown** / **NOT ESTABLISHED** unless that layer’s own text states it.

User quality-first vs balanced default is still unanswered and is not authorized by this file.

**2026-09-10 wording correction (same five overclaims, all occurrences):** (1) README omission ≠ absent CLI flag. (2) CLI menu/config tokens vs API effort are layer differences; translation UNKNOWN, not “unsupported”. (3) Grok model ID + API four-token band ≠ local CLI model mapping. (4) agy slug/`--effort` → Gemini `thinking_level` wire mapping NOT ESTABLISHED. (5) Claude docs minimum version + newer installed CLI ≠ exact-version/model runtime proof. Repo `xhigh` vs documented `high` kept as values, not a fix/default approval.

## 1. Evidence matrix

Legend: **match** / **both** = same-layer local surface and official page name the same tokens/flag (vocabulary overlap, not runtime, not cross-layer translation). **mismatch** = they disagree **on the same layer** (version limits apply). **unknown** = official page silent, not version-pinned to this binary, or the compared layers differ so translation is unproven. **NOT ESTABLISHED** = exact requested identity or wire mapping not found (identity preserved, not substituted). Cross-layer token disagreement is **unknown**, not proof the CLI token is unsupported/wrong. README/docs prose is not an exhaustive flag inventory.

| Tuple (installed) | Local (E7-local) | Official CLI/product | Official model/API | Verdict |
|---|---|---|---|---|
| claude 2.1.266 / `claude-opus-5` | `--effort` `low medium high xhigh max`. Model ID not in `--help`. Repo default effort `xhigh`. | Claude Code: `--effort` `low, medium, high, xhigh, max` plus `ultracode` (CLI setting → `xhigh` + workflows). Docs: Opus 5 requires CLI **v2.1.219+**. Capture binary is 2.1.266 — **version-floor overlap only**, not exact-version or model-application proof. Default effort on Opus 5 / most models: **`high`** (Opus 4.7: `xhigh`). | API ID `claude-opus-5`. Effort `low/medium/high/xhigh/max`. Default **`high`**. `xhigh` listed for Opus 5. | **both for documented five-token vocabulary overlap** (local `--help` and official CLI/API pages name `low/medium/high/xhigh/max`). `ultracode` official extra vs this `--help`. Repo declared `xhigh` vs official Opus 5 default `high`: **value difference recorded**, not a fix and not default-policy approval. Installed 2.1.266 application of `claude-opus-5` **unmeasured**. |
| codex 0.153.4 / `gpt-6-astra` | Bundled catalog: default **`low`**; band `low medium high xhigh max ultra`. Writer `-c model_reasoning_effort=` default **`high`**. Help does not name the key. | Config basics: `model_reasoning_effort = "high"`; `-c` overrides. Config reference type: `minimal \| low \| medium \| high \| xhigh` (**no `max`/`ultra`**). Models page: CLI `/model` picker for **gpt-5.6-sol** shows Low…Max + Ultra (subagent mode). `codex -m gpt-6-astra` is recommended. Current Codex docs are **not pinned to 0.153.4**. | Model page: `reasoning.effort` supports `low, medium, high, xhigh, and max`. Astra **does not support `none`**. Generic reasoning page also lists `none/minimal` as model-dependent. **`ultra` not on Astra API page.** | **both for config key name**. Same-surface CLI/config (version-unpinned docs vs 0.153.4 catalog): local catalog includes `max`/`ultra`; current config-ref type omits both. Cross-layer: API lists `low…max` (no `ultra`); whether CLI `ultra` translates to API `max` (or is accepted for Astra) is **UNKNOWN**, not proof the CLI token is unsupported/wrong. Catalog default `low` vs writer/docs example `high`. Runtime unmeasured. |
| grok 1.0.24 / `grok-4.6` | Help: `--reasoning-effort` alias `--effort`, **no values**. Shipped local lists disagree (`none…max` vs slash `low…xhigh` vs ACP `minimal…xhigh`). | Official Build: `/effort` exists; values **not enumerated**. Headless “common flags” table **omits** `--reasoning-effort`. `[models] default_reasoning_effort` = “effort level if supported”. | `grok-4.6` exists. API: `low/medium/high` (default **high**) / `xhigh` on 4.6+. Reasoning cannot be disabled. No `none`/`minimal`/`max` on this model page. | **match** for API model ID `grok-4.6`. API four-token band is **API-layer only** and does **not** establish this CLI’s accepted/model-specific mapping. Local CLI flag **exists**; official CLI **does not enumerate values** (unknown vs this 1.0.24 help). Local shipped token lists vs API vocabulary are **different layers**; translation **UNKNOWN**, not proof those CLI tokens are unsupported. Runtime unmeasured. |
| agy 1.1.28 / `gemini-3.8-flash-high` (kind `gemini`) | `--effort` `low\|medium\|high`. Model slug absent from `--help`. `agy models` not executed. | Antigravity CLI: `--effort` `low, medium, or high`. Official example `agy models` listing **includes** `gemini-3.8-flash-high`. Headless does not silently fallback on unknown `--model`. Docs are **not pinned to 1.1.28**. | Gemini API model is `gemini-3.8-flash` + `thinking_level` `low/medium/high` (default medium). Official agy example uses hyphenated slug `gemini-3.8-flash-high`. Whether agy `--effort` or that slug maps to Gemini `thinking_level` / API model id on the wire is **NOT ESTABLISHED** (identical words ≠ transport). | **both for `--effort` low\|medium\|high** as CLI-documented tokens. Slug `gemini-3.8-flash-high` **appears in official agy example**; this host’s live catalog still unknown (`agy models` not run). CLI-to-API mapping **NOT ESTABLISHED**. Runtime unmeasured. |
| gemini 0.53.0 / `gemini-2.5-flash` | No `--effort` / `--reasoning-effort` in help. Adapter has none. | v0.53.0 README: `gemini -m gemini-2.5-flash`. README does **not** name an effort flag; a README is **not** an exhaustive flag inventory. Current geminicli.com is **not** this tag (site now points unpaid users at Antigravity). | Current thinking docs: `gemini-2.5-flash` supports `thinking_level` `low, medium, high` (API, not this CLI). | Local help + adapter: **no** effort flag (E7-local negative observation). S17 supplies the version-pinned **model example** only — **not** “both for no CLI effort flag”. Generic API thinking is **not** a CLI translation. Runtime unmeasured. |

agy and gemini-cli remain **distinct implementations**.

## 2. Per-tuple notes (short)

### 2.1 claude / `claude-opus-5`

Official Claude Code effort table lists Opus 5 on `low, medium, high, xhigh, max`. That is the same five-token **vocabulary** as this 2.1.266 `--help` band. `ultracode` is documented as a Claude Code setting, not a model effort token; this installed `--help` does not name it (official CLI reference also says `--help` may omit flags).

Docs’ Opus 5 floor **v2.1.219+** plus installed **2.1.266** is version-floor overlap, not proof this exact binary applies `claude-opus-5` effort as the current docs describe.

Repo declared default `xhigh` is a **local source default**. Official Opus 5 default is `high` on API and Claude Code except Opus 4.7. Those are recorded values. This file does not approve a fix or a live default. Docs do not prove the dispatching process env or account.

### 2.2 codex / `gpt-6-astra`

Preserve identity `gpt-6-astra`. Official API page lists five efforts ending at `max`. Local 0.153.4 bundled row adds `ultra` and defaults `low`. Official Codex config-ref omits both `max` and `ultra` (**same-surface CLI/config type vs this catalog**, docs not pinned to 0.153.4). Codex Models “Ultra” is described as subagent delegation; the illustrated picker is **gpt-5.6-sol**, not Astra. Do not treat that screenshot as Astra’s band.

Whether 0.153.4 `-c model_reasoning_effort=ultra` is accepted for Astra, and whether that CLI token translates to API `max` (or any API value), is **unknown** from current public docs — not proof the CLI combination is unsupported/wrong. The bundled catalog is local schema, not provider proof.

### 2.3 grok / `grok-4.6`

Official API: four levels, default `high`, cannot disable. That API band plus model-card ID `grok-4.6` does **not** establish this 1.0.24 CLI’s accepted tokens for that model.

Official CLI documents `/effort` and `default_reasoning_effort` without a token list; headless flag table does not include `--reasoning-effort` even though local `--help` does. That is a **CLI docs vs local help** gap, not proof the flag is absent in 1.0.24 (local help already recorded it). Local shipped `none`/`minimal`/`max`/`deep` vs API `low/medium/high/xhigh` are layer differences; translation **UNKNOWN**.

### 2.4 agy / `gemini-3.8-flash-high`

Official Antigravity CLI documents `--effort low|medium|high` and an example slug `gemini-3.8-flash-high`. Those are CLI-surface strings. Generic Gemini `thinking_level` / `gemini-3.8-flash` is API vocabulary. **Wire mapping from agy `--effort` or the hyphenated slug to that API is NOT ESTABLISHED**; this file does not claim an “API underneath” or a definite slug-to-API translation. Official `agy models` sample is documentation, not this account’s catalog.

### 2.5 gemini-cli 0.53.0 / `gemini-2.5-flash`

E7-local: this 0.53.0 `--help` and the repo adapter have no `--effort` / `--reasoning-effort`. Version-pinned README (`v0.53.0`) shows `-m gemini-2.5-flash` and does not name an effort flag. **README omission cannot establish absence of a CLI flag.** Current thinking docs for `gemini-2.5-flash` are generic API. Using later geminicli.com pages as proof of 0.53.0 would be invalid.

## 3. Policy / spec boundary

Adaptive-routing spec is context-only. This file does not pick quality-first vs balanced, does not change live defaults, and does not emit `verified_by: both` as approved metadata. Candidate both observations above are documentation matches only.

## 4. Source list

Original retrieval dates below are **2026-09-09 author attribution**. This correction session did not re-GET these URLs; quotes/summaries remain original-fetch claims, not 2026-09-10 verification.

| # | URL | Retrieved UTC | Applicability | Used for |
|---|---|---|---|---|
| S1 | https://code.claude.com/docs/en/model-config | 2026-09-09 | Claude Code current docs; Opus 5 needs v2.1.219+ (**floor, not 2.1.266/runtime proof**) | CLI effort table, defaults, `--effort` |
| S2 | https://platform.claude.com/docs/en/build-with-claude/effort | 2026-09-09 | Claude API current | `claude-opus-5` effort levels/default |
| S3 | https://platform.claude.com/docs/en/models/opus-5/overview | 2026-09-09 | Model ID `claude-opus-5` | identity + default `high` |
| S4 | https://developers.openai.com/api/docs/models/gpt-6-astra | 2026-09-09 | API model page (not Codex 0.153.4; **not CLI acceptance**) | Astra API `low…max`; API page has no `ultra` |
| S5 | https://developers.openai.com/api/docs/guides/reasoning | 2026-09-09 | Generic API | model-dependent vocab; Astra no `none` |
| S6 | https://developers.openai.com/api/docs/guides/latest-model | 2026-09-09 | Astra migration | `none`/`minimal` → start `low` |
| S7 | https://learn.chatgpt.com/codex/config-file/config-basic | 2026-09-09 | Current Codex docs, not 0.153.4-pinned | `model_reasoning_effort` |
| S8 | https://learn.chatgpt.com/codex/config-file/config-reference | 2026-09-09 | Current Codex docs (**same-surface type vs 0.153.4 catalog; unpinned**) | type `minimal\|low\|medium\|high\|xhigh` |
| S9 | https://learn.chatgpt.com/codex/models | 2026-09-09 | Current Codex product | `codex -m gpt-6-astra`; Ultra=subagents; picker example is gpt-5.6-sol |
| S10 | https://docs.x.ai/developers/model-capabilities/text/reasoning | 2026-09-09 | xAI API current (**API-layer only; not Grok CLI mapping**) | `grok-4.6` API `low/medium/high/xhigh` |
| S11 | https://docs.x.ai/developers/models/grok-4.6 | 2026-09-09 | Model card | identity `grok-4.6` |
| S12 | https://docs.x.ai/build/modes-and-commands | 2026-09-09 | Grok Build CLI current, not 1.0.24-pinned | `/effort` unnamed values |
| S13 | https://docs.x.ai/build/cli/headless-scripting | 2026-09-09 | Grok Build CLI | common flags omit `--reasoning-effort` |
| S14 | https://docs.x.ai/build/settings/reference | 2026-09-09 | Grok Build CLI | `default_reasoning_effort` unenumerated |
| S15 | https://antigravity.google/docs/cli/headless | 2026-09-09 | Official agy CLI, not 1.1.28-pinned | `--effort`; sample `gemini-3.8-flash-high` (CLI strings, not API wire) |
| S16 | https://ai.google.dev/gemini-api/docs/thinking | 2026-09-09 | Gemini API current (**not agy or gemini-cli translation**) | `thinking_level`; `gemini-3.8-flash` / `gemini-2.5-flash` |
| S17 | https://github.com/google-gemini/gemini-cli/blob/v0.53.0/README.md | 2026-09-09 | **Pinned** gemini-cli 0.53.0 README (**not a complete flag inventory**) | `-m gemini-2.5-flash` example; README does not name an effort flag |

Search-only / third-party pages (YouTube, Medium, keli-wen/agy-staff, Apidog) were **not** used as evidence.

Inaccessible/redirect notes: `developers.openai.com/codex/config-basic` and `…/codex-manual.md` redirected to `learn.chatgpt.com` (followed, 2026-09-09). `docs.x.ai/developers/grok-4-6.md` 404; HTML model card S11 used instead.

## 5. Unmeasured (still)

- Provider application of a parsed token to the declared model (any tuple).
- This account’s live `agy models` / `grok models` catalogs.
- Exact Codex **0.153.4** public config schema vs current S8 (max/ultra), and whether `model_reasoning_effort=ultra` is **accepted** for `gpt-6-astra`.
- CLI-to-API effort translation (Codex `ultra`↔API `max`; Grok shipped tokens↔API band; agy `--effort`/slug↔`thinking_level`).
- Gemini 0.53.0 complete CLI flag inventory (README not exhaustive; help/adapter remain the local negative observation).
- Claude 2.1.266 exact-version application of `claude-opus-5` effort (docs floor v2.1.219+ is not that proof).
- Effective `AIGENTRY_*` env vs declared defaults.
- User default-policy (quality-first vs balanced).

## 6. Next validation suggestion (information only; not executed)

One bounded #1148 follow-up: on the **same captured Codex 0.153.4** binary, obtain a non-inference, version-pinned **CLI-layer** acceptance signal for `-c model_reasoning_effort=ultra` with `gpt-6-astra` (config schema, config-key help, or a dry validator the binary already exposes). That would turn the current UNKNOWN CLI↔API translation into a same-layer CLI fact. Not permission to change capability metadata or defaults.
