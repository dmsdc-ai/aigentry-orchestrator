# E7-local CLI effort/model capability capture (task #1148)

- **Kind**: retained command/evidence report. Not production code, not approved capability metadata, not a routing decision.
- **Captured (UTC)**: 2026-09-09T13:14:24Z–13:17:13Z
- **Author session**: `cp1148-builder` (builder; bounded help/version/catalog capture only)
- **Worktree**: `/Users/duckyoungkim/.aigentry/worktrees/cp1148`
- **Branch**: `evidence/1148-effort-capabilities`
- **Repo HEAD**: `9eac5b3ceb60fad2f4d902e23cb37439d8790f1e` (`docs(1148): correct effort contract against source review (r2)`, 2026-09-09 22:08:35 +0900)
- **Local `main`**: identical to HEAD (`9eac5b3…`, ahead/behind `0 0`)
- **`origin/main`**: `a536cd8b303f6781ccccc9f4817aa8a6c0416845` (2026-08-30). HEAD is 2030 commits ahead of that remote-tracking ref. No fetch/push was run.
- **Snyk**: N/A (report-only; no first-party code generated)
- **Build/test**: not run (not authorized)

Read-only spec context (not an implementation instruction): `docs/specs/2026-09-09-adaptive-model-effort.md` (`git hash-object` `8c11bf9a7a1db922926662fc17171e50fe03f07c`).

This report is the local half of E7. Provider primary-doc corroboration is **not measured in E7-local**. No `verified_by: both` row is emitted.

---

## 0. Limits of this measurement

**Executed (this report):** `command -v` / `type -a` / `ls` / `file` / `realpath` / package-metadata reads of the resolved binaries; isolated `--version` / `--help` / discovered subcommand `--help`; one catalogue command whose installed help named a bundled/offline dump (`codex debug models --bundled`).

**Not executed (named, not “unsupported”):** any `-p` / prompt / inference; login/auth/logout; updater; `npm`/`npx` install; `git push`; live dispatch/router (classifier can be billable); `codex debug models` without `--bundled` (help documents a refresh path); `grok models`; `agy models`; `agy changelog`; `gemini gemma setup` (help: download); `claude auto-mode critique` (help: AI feedback); any paid API.

**Not measured:** provider honouring of a parsed token for a given model; cost/latency of a tier; live user config / env overrides (`AIGENTRY_*_MODEL` / `AIGENTRY_*_EFFORT` effective values); account state; network model lists.

**Parser/catalog vs provider:** a help flag, a parser-accepted token, or a bundled catalog row is **not** proof the provider applies that token to that model.

A timeout or empty stream is **not** evidence of “unsupported”. No command in this run timed out.

---

## 1. Capture fixture (env KEY names only)

Child processes used `env` rebuilt from an empty set (no ambient credentials, no `AIGENTRY_*`). Executable paths were resolved in the live `PATH` **before** the child env was applied.

**Env KEY names passed:**

`CI`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COLUMNS`, `GEMINI_CLI_HOME`, `GIT_PAGER`, `HOME`, `LANG`, `LC_ALL`, `LINES`, `MANPAGER`, `NO_COLOR`, `PAGER`, `PATH`, `TEMP`, `TERM`, `TMP`, `TMPDIR`, `XDG_CACHE_HOME`, `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME`

**Synthetic temp paths (values are fixture, not user state):**

| KEY | path |
|---|---|
| `HOME` | `/tmp/cp1148-e7-capture/home` |
| `TMPDIR` / `TMP` / `TEMP` | `/tmp/cp1148-e7-capture/tmp` |
| `CODEX_HOME` | `/tmp/cp1148-e7-capture/codex-home` |
| `GEMINI_CLI_HOME` | `/tmp/cp1148-e7-capture/gemini-home` |
| `CLAUDE_CONFIG_DIR` | `/tmp/cp1148-e7-capture/claude-config` |
| `XDG_*` | `/tmp/cp1148-e7-capture/xdg-{config,cache,data,state}` |

`PATH` in the child: `/Users/duckyoungkim/.local/bin` + nvm `v20.20.0/bin` + `/opt/homebrew/bin` + `/usr/bin:/bin` (and `/usr/sbin:/sbin` on phase A). `PAGER=cat`, `TERM=dumb`, `COLUMNS=200`, timeout 15s, stdin `/dev/null`, cwd = fixture `HOME`.

`CLAUDE_CONFIG_DIR` was set as an explicit temp config root (per capture contract) and was **not** discovered from `claude --help` first.

Fixture side-effects stayed under `/tmp/cp1148-e7-capture/` (gemini wrote empty `{"projects": {}}` tmp files under `GEMINI_CLI_HOME/.gemini/`; empty `HOME/.grok` dir). No capture CLI process remained after the command set. Live user `~/.codex/auth.json` / keychain / login were not read or written.

---

## 2. Repo source currentness (static; SHA preserved)

Static reads only: `docs/model-profiles/model-routing-profile.md`, `src/dispatch/cli.ts`, `bin/boot-prepare.mjs`, `src/session/boot-adapter/*.ts`, `bin/model-router.mjs`. No `model-router.mjs` execution.

`git hash-object` on HEAD `9eac5b3` (12-char prefix). These blobs match the r2 spec’s listed 12-char hashes for the same paths (spec §0, written against earlier commits whose blobs were recorded as identical):

| path | `git hash-object` |
|---|---|
| `docs/model-profiles/model-routing-profile.md` | `a937791c86e53f4032d65697ef642b63dd0dac17` |
| `src/dispatch/cli.ts` | `c29fe73f9eaf9e594fcf34577efb9f9af8efcbf3` |
| `bin/boot-prepare.mjs` | `5c1136610de4ae64b9bb1990bdf8202b5ba45126` |
| `bin/model-router.mjs` | `3737b92ddfd7887c1cc95d018731e50da77edf7c` |
| `src/session/boot-adapter/claude.ts` | `b3894e18f0a4ce32cea506a14a2a432ef5b87f2a` |
| `src/session/boot-adapter/codex.ts` | `0f9f25685167187d7d4ada58daead368cb4b6d38` |
| `src/session/boot-adapter/grok.ts` | `26b07de96fe49a43d028fd5cf17c0a3832fa9d0a` |
| `src/session/boot-adapter/gemini.ts` | `926321f8ea260a9af27f46748d71e9b20c37ce27` |
| `src/session/boot-adapter/index.ts` | `12a8fa271f385715677d4de0b6bb415d2a8ef962` |
| `docs/specs/2026-09-09-adaptive-model-effort.md` | `8c11bf9a7a1db922926662fc17171e50fe03f07c` |

sha256 of the same files (this capture): profile `919058eca60e…fac40b5c0`; `cli.ts` `332050db6fec…e327676ed`; `boot-prepare.mjs` `04967b05a247…ce7ac9`; `gemini.ts` `6c3e309d38ec…c1e47de`; `codex.ts` `5a1c1e6bf1d2…111543bd`; `grok.ts` `01dd4d139a29…1af797b8`; `claude.ts` `8059adcd3fe0…ad0a96dfb080d`.

---

## 3. Declared dispatch mapping (source text, not live config)

Advertised CLI kinds in `bin/model-router.mjs:50` and `src/session/boot-adapter/types.ts`: **`claude` | `codex` | `grok` | `gemini`**. Kind `gemini` is not a binary name. `agy` is not a kind; `geminiBinary()` (`gemini.ts:16-21`) returns `"agy"` if `AIGENTRY_GEMINI_BINARY` is `agy`/`gemini` or if `agy` is executable on `PATH`, else `"gemini"`. `cliKindOf` maps basename `agy` → kind `gemini`.

**Declared defaults vs writers** (hardcoded literals / env KEY names in source; effective live env was not measured):

| Kind | Binary (declared) | Declared model default | Declared effort | Writer reached on role dispatch |
|---|---|---|---|---|
| `claude` | `claude` | `AIGENTRY_CLAUDE_MODEL` or `claude-opus-5` (`boot-prepare.mjs:671`; `cli.ts:129`; explicit `--cli` `cli.ts:425`) | `AIGENTRY_CLAUDE_EFFORT` or `xhigh`; flag `--effort` | W2 `boot-prepare.mjs:671-676` (adapter `claude.ts` has neither). Profile emergency label `claude-opus-5[1m]` (`model-router.mjs:8`, `cli.ts:459`) |
| `codex` | `codex` | `AIGENTRY_CODEX_MODEL` or `gpt-6-astra` | `AIGENTRY_CODEX_EFFORT` or `high` as `-c model_reasoning_effort=` | W3 `codex.ts:39-48` (always emitted) |
| `grok` | `grok` | `AIGENTRY_GROK_MODEL` or `grok-4.6` | `AIGENTRY_GROK_EFFORT` opt-in `--reasoning-effort` | W4 `grok.ts:10-11` |
| `gemini` when `geminiBinary()=="agy"` | `agy` | `AIGENTRY_GEMINI_MODEL` or `gemini-3.8-flash-high` | `AIGENTRY_GEMINI_EFFORT` opt-in `--effort` | W5 `gemini.ts:61-63` |
| `gemini` when binary is `gemini` | `gemini` | `AIGENTRY_GEMINI_MODEL` or `gemini-2.5-flash` | none in adapter | `gemini.ts:72-82` (`-m`, `--approval-mode yolo`, `--skip-trust`) |

On successful `boot-prepare`, `spawnWorkspace` (`cli.ts:1003`) wraps the launcher with **empty** extra flags, so `defaultCliFlags` (`cli.ts:126-141`, W1) is the legacy/no-role arm only. `resolveRoute` (`cli.ts:952-953`) puts **model only** into `spawnEnv` (`AIGENTRY_<CLI>_MODEL`). Effort is read from the dispatching process env at the writers above.

Profile YAML (`docs/model-profiles/model-routing-profile.md`, `measured_at: 2026-09-05`) still records CLI versions **claude 2.1.261 / codex 0.153.4 / grok 0.2.93 / agy 1.1.27 / gemini-cli 0.53.0**. Those version strings are historical in-repo text, not this capture.

This host: `agy` **is** on live `PATH`, so declared kind `gemini` resolves to binary `agy` and model `gemini-3.8-flash-high` unless `AIGENTRY_GEMINI_BINARY` overrides (override not measured).

---

## 4. Per-binary observations

PATH-first resolution (live `PATH` at capture; `command -v` then `realpath`). Additional `type -a` hits are identity facts, not executed unless named.

### 4.1 claude — PATH-first 2.1.266

| Item | Observation |
|---|---|
| `command -v` | `/Users/duckyoungkim/.local/bin/claude` |
| realpath | `/Users/duckyoungkim/.local/share/claude/versions/2.1.266` (Mach-O arm64, 199422144 bytes) |
| `--version` | exit 0, 0.118s, stdout `2.1.266 (Claude Code)` (2026-09-09T13:14:24Z) |
| Additional PATH | nvm `…/bin/claude` → `@anthropic-ai/claude-code@2.1.198` (`package.json`); **not executed**. cmux shim also listed |
| `--help` effort | **present**: `--effort <level>` “Effort level for the current session **(low, medium, high, xhigh, max)**” |
| `--help` model | **present**: `--model <model>` “alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5')”. **No** enumerated installed-model catalog |
| `--help` other flags used by dispatch | `--permission-mode` choices include `bypassPermissions`; `--append-system-prompt <prompt>` listed; `--bare` text mentions `--append-system-prompt[-file]` |
| Catalog subcommand | **none** named `models`. `auto-mode --help` is classifier config (local `defaults`/`config`; `critique` is AI — not run) |
| Help tokens vs declared | help band `low medium high xhigh max` (no `ultra` in this help). Declared default effort `xhigh` **is** in that help list. Declared model `claude-opus-5` is **not** listed as a token in `--help` (aliases shown: fable/opus/sonnet / `claude-fable-5`) |
| Provider | not measured in E7-local |

### 4.2 codex — PATH-first 0.153.4

| Item | Observation |
|---|---|
| `command -v` | `/opt/homebrew/bin/codex` → Homebrew Cask `codex` 0.153.4 (`/opt/homebrew/Caskroom/codex/0.153.4/bin/codex`, Mach-O arm64). `codex-package.json` `"version": "0.153.4"` |
| `--version` | exit 0, 0.014s, stdout `codex-cli 0.153.4` (13:14:25Z) |
| `--help` model | `-m, --model <MODEL>` “Model the agent should use” — **no** token list |
| `--help` effort flag | **no** `--effort` / `--reasoning-effort`. `-c, --config <key=value>` documents dotted config overrides; example is `-c model="o3"`, **not** `model_reasoning_effort` |
| Subcommands from `--help` | includes `debug` “Debugging tools”, `exec`, `features` |
| `codex debug --help` | Commands: `models` “Render the raw model catalog as JSON”; `app-server`; `prompt-input` |
| `codex debug models --help` | **`--bundled`**: “Skip refresh and dump only the bundled catalog shipped with this binary”. That clause is the local/offline basis used below |
| `codex debug models` (no `--bundled`) | **NOT EXECUTED / UNVERIFIED** — help implies a refresh path |
| `codex debug models --bundled` | **executed** (13:17:13Z, exit 0, 0.017s, stdout 517840 bytes, sha256 `32bdd1fe3ffd82df3d03c6c9b9d9068087cd9640ded4377f604586d7a743749b`). JSON top-level key `models` only; **11** rows |
| Bundled catalog `gpt-6-astra` | `default_reasoning_level`: **`low`**. `supported_reasoning_levels[].effort`: **`low medium high xhigh max ultra`**. `visibility`: `list`. `multi_agent_reasoning_effort`: `xhigh`. Full row JSON 85803 chars (base_instructions etc. not copied here) |
| Catalog vs config key name | catalog JSON does **not** contain the string `model_reasoning_effort`. It uses `default_reasoning_level` / `supported_reasoning_levels` / `effort`. Binary `strings` of this 0.153.4 image **do** contain `model_reasoning_effort` and the literal `model_reasoning_effort = "low"` (local binary text, not help, not provider) |
| Repo writer vs catalog default | W3 emits `-c model_reasoning_effort=` default **`high`**. Bundled catalog default for `gpt-6-astra` is **`low`**. These are two local facts; which one the provider applies is unmeasured |
| Provider | not measured in E7-local |

Bundled catalog effort columns (complete for this dump’s `models.length == 11`; not a claim that the provider’s live set equals this list):

| slug | catalog default | supported_reasoning_levels[].effort | visibility |
|---|---|---|---|
| `gpt-6-astra` | low | low medium high xhigh max ultra | list |
| `gpt-5.6-sol` | low | low medium high xhigh max ultra | list |
| `gpt-5.6-terra` | medium | low medium high xhigh max ultra | list |
| `gpt-5.6-luna` | medium | low medium high xhigh max | list |
| `gpt-daybreak-blue-latest` | low | low medium high xhigh max ultra | hide |
| `gpt-daybreak-red-latest` | medium | low medium high xhigh max ultra | hide |
| `gpt-5.5` | medium | low medium high xhigh | list |
| `gpt-5.4` | medium | low medium high xhigh | hide |
| `gpt-5.4-mini` | medium | low medium high xhigh | hide |
| `gpt-5.2` | medium | low medium high xhigh | list |
| `codex-auto-review` | medium | low medium high xhigh max | hide |

Union of catalog effort tokens in this dump: `low medium high xhigh max ultra`. `none` / `minimal` were **not** in `supported_reasoning_levels` of these 11 rows. Binary strings also contain `"reasoning_effort": "none"` elsewhere in the image — not attached to this bundled dump’s 11 rows.

### 4.3 grok — PATH-first 1.0.24

| Item | Observation |
|---|---|
| `command -v` | `/Users/duckyoungkim/.local/bin/grok` → `/Users/duckyoungkim/.grok/downloads/grok-1.0.24-macos-aarch64` (Mach-O arm64) |
| Install metadata | `~/.grok/version.json` `"version": "1.0.24"` (file also has `checked_at`; value not used beyond version identity) |
| `--version` | exit 0, 0.044s, stdout `grok 1.0.24 (68e414c661e3)` |
| Additional PATH | `~/.grok/bin/grok` same realpath. cmux wrapper `/Applications/cmux.app/Contents/Resources/bin/grok` is a bash shim (4335 bytes), later on PATH; **not executed** |
| `--help` model | `-m, --model <MODEL>` “Model ID to use” — **no** token list |
| `--help` effort | **present**: `--reasoning-effort <EFFORT>` “Reasoning effort for reasoning models” `[aliases: --effort]`. **No** token list in `--help`/`-h` |
| `grok models --help` | “List available models and exit”. Options: `--debug`, `--debug-file`, `--help`, `--leader-socket`. **Does not** state local/offline |
| `grok models` | **NOT EXECUTED / UNVERIFIED**. Shipped README documents `grok models` and also documents fetching a model list from `{GROK_MODELS_BASE_URL}/models` for custom endpoints. Default-path offline behavior is not established by help |
| Local shipped docs (non-paid, install tree) | README `~/.grok/README.md:586`: `--reasoning-effort` / `--effort <LEVEL>` tokens **`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`**; “also per-model menu ids like `deep`”. User-guide `14-headless-mode.md:37`: same canonical list, “a model only accepts the levels its menu advertises”. `04-slash-commands.md:110-112`: `/effort` levels **`low`, `medium`, `high`, `xhigh` only**. `15-agent-mode.md:183`: ACP `reasoning_effort` string ids **`minimal`, `low`, `medium`, `high`, `xhigh`**. These three lists are **not identical**; this report does not pick a winner |
| Local model ID examples in shipped docs | `grok-4.6` appears as examples in user-guide (e.g. `01-getting-started.md:167`, `04-slash-commands.md:105`, `14-headless-mode.md:24`). README examples often use `grok-build`. `11-custom-models.md:9`: “new sessions start with `grok-4.5`”. **Not** an executed catalog |
| vs declared | declared model `grok-4.6` appears in shipped user-guide examples. Declared effort is opt-in; help flag exists. Profile text “grok 0.2.93” does **not** match this binary `1.0.24` |
| Provider | not measured in E7-local |

### 4.4 agy (kind `gemini` when on PATH) — PATH-first 1.1.28

| Item | Observation |
|---|---|
| `command -v` | `/Users/duckyoungkim/.local/bin/agy` (Mach-O arm64, 177756720 bytes) |
| `--version` | exit 0, 3.215s, stdout `1.1.28` |
| Additional PATH | `~/.antigravity/antigravity/bin/agy` is a **dangling** symlink → `/Applications/Antigravity.app/Contents/Resources/app/bin/antigravity` (lexists, target missing). Not executed |
| `--help` (stderr; stdout empty) | `--effort` “Reasoning effort for the current CLI session **(low\|medium\|high)**”. `--model` “Model for the current CLI session” — **no** token list. `--dangerously-skip-permissions` present. Subcommand `models` “List available models” |
| `agy models --help` | “List available models”; flags `-h`/`--help` only. **Does not** state local/offline |
| `agy models` | **NOT EXECUTED / UNVERIFIED** (a spec/profile naming this command is not offline proof) |
| vs declared | declared default model `gemini-3.8-flash-high` is **absent** from this `--help`. Declared effort opt-in `--effort`; help tokens are `low\|medium\|high` only (no `xhigh`/`max`/`ultra` in this help). Profile text “agy 1.1.27” does **not** match `1.1.28` |
| Provider | not measured in E7-local |

### 4.5 gemini (gemini-cli) — PATH-first 0.53.0

| Item | Observation |
|---|---|
| `command -v` | `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/gemini` → `@google/gemini-cli@0.53.0` `bundle/gemini.js` |
| `--version` | exit 0, 0.834s, stdout `0.53.0` |
| `--help` model | `-m, --model` “Model  [string]” — **no** token list |
| `--help` effort | **absent** (no `--effort` / `--reasoning-effort`) |
| Commands | `mcp`, `extensions`, `skills`, `hooks`, `gemma` “Manage local Gemma model routing” — **no** `models` catalog |
| `gemini gemma --help` | `setup` “Download and configure…” — **not executed**. Not the cloud Gemini catalog |
| Local package README | example `gemini -m gemini-2.5-flash` (`README.md:233`). Other `gemini-2.5*` / `gemini-3*` strings exist in the installed package JS/docs; that is not a help catalog and is not counted exhaustive |
| Local package grep for effort flags | no `--effort` / `reasoning_effort` surface in scanned package text (English “best effort” only) |
| vs declared | adapter for this binary has **no** effort flag (matches this `--help`). Declared default `gemini-2.5-flash` appears in the package README example. On this host kind `gemini` does **not** spawn this binary unless `agy` is absent or `AIGENTRY_GEMINI_BINARY=gemini` |
| Provider | not measured in E7-local |

---

## 5. Data-only candidate rows (later review; not E2)

Legend: `evidence_kind` is local only. **`verified_by` is never `both` here.** `provider-doc` = not measured in E7-local. A missing catalog command is `unknown` for model lists, not “no models”.

```yaml
# NOT approved capability metadata. Adaptation is not authorized by this file.
# measured_at: 2026-09-09T13:17:13Z
# host_path_first_only: true

- binary: claude
  version: "2.1.266"
  version_source: "--version"
  declared_kind: claude
  declared_model_default: claude-opus-5   # source; not in --help token list
  effort_surface: "--effort <level>"
  help_tokens: "low medium high xhigh max"
  catalog_models: unknown                 # no models subcommand
  evidence_kind: help-only
  verified_by: help
  provider_proof: not-measured-in-E7-local

- binary: codex
  version: "0.153.4"
  version_source: "--version + brew cask + codex-package.json"
  declared_kind: codex
  declared_model_default: gpt-6-astra     # present as bundled catalog slug
  effort_surface_help: "-c/--config <key=value> (key model_reasoning_effort NOT named in --help)"
  effort_surface_repo_writer: "-c model_reasoning_effort="
  effort_surface_binary_strings: "model_reasoning_effort (literal default \"low\" appears in image)"
  bundled_catalog_gpt-6-astra_default: low
  bundled_catalog_gpt-6-astra_band: "low medium high xhigh max ultra"
  repo_writer_default: high
  evidence_kind: help+bundled-catalog+binary-strings
  verified_by: help                       # bundled catalog is local schema, still not provider
  provider_proof: not-measured-in-E7-local

- binary: grok
  version: "1.0.24"
  version_source: "--version + ~/.grok/version.json"
  declared_kind: grok
  declared_model_default: grok-4.6        # shipped user-guide examples; models cmd NOT EXECUTED
  effort_surface: "--reasoning-effort (alias --effort)"
  help_tokens: unknown                    # flag present, values not in --help
  shipped_doc_tokens_readme: "none minimal low medium high xhigh max (+ per-model ids e.g. deep)"
  shipped_doc_tokens_slash_effort: "low medium high xhigh"
  shipped_doc_tokens_acp: "minimal low medium high xhigh"
  grok_models_command: NOT_EXECUTED
  evidence_kind: help-flag + shipped-docs
  verified_by: help                       # docs are local; not provider
  provider_proof: not-measured-in-E7-local

- binary: agy
  version: "1.1.28"
  version_source: "--version"
  declared_kind: gemini                   # geminiBinary() → agy on this PATH
  declared_model_default: gemini-3.8-flash-high  # not in --help
  effort_surface: "--effort"
  help_tokens: "low|medium|high"
  agy_models_command: NOT_EXECUTED
  evidence_kind: help-only
  verified_by: help
  provider_proof: not-measured-in-E7-local

- binary: gemini
  version: "0.53.0"
  version_source: "--version + npm package.json"
  declared_kind: gemini                   # only if geminiBinary() returns gemini
  declared_model_default: gemini-2.5-flash
  effort_surface: none-in-help
  help_tokens: not-applicable
  catalog_models: unknown
  evidence_kind: help-only
  verified_by: help
  provider_proof: not-measured-in-E7-local
```

Historical in-repo vocabulary (profile/ADR/spec, **not re-validated as current except where this capture overlaps**): spec §0.3 claimed claude full set unknown; this `--help` now lists `low medium high xhigh max`. Spec cited codex band `low medium high xhigh max ultra` on 0.153.4; this bundled catalog’s `gpt-6-astra` row contains that same six-token list. Spec cited grok/agy values unmeasured; this capture adds help/docs facts above. Spec cited gemini-cli no effort flag; this `--help` still has none.

---

## 6. Command log (complete for this run)

All exit 0, none timed out. argv is the resolved binary path.

| started_utc | argv (after binary) | elapsed_s | stdout_B | stderr_B |
|---|---|---|---|---|
| 13:14:24Z | claude `--version` | 0.118 | 22 | 0 |
| 13:14:25Z | claude `--help` | 0.238 | 21393 | 0 |
| 13:14:25Z | claude `-h` | 0.065 | 21393 | 0 |
| 13:14:25Z | codex `--version` | 0.014 | 18 | 0 |
| 13:14:25Z | codex `--help` | 0.011 | 5577 | 0 |
| 13:14:25Z | codex `-h` | 0.010 | 5311 | 0 |
| 13:14:25Z | grok `--version` | 0.044 | 27 | 0 |
| 13:14:25Z | grok `--help` | 0.011 | 7381 | 0 |
| 13:14:25Z | grok `-h` | 0.010 | 7045 | 0 |
| 13:14:25Z | agy `--version` | 3.215 | 7 | 0 |
| 13:14:28Z | agy `--help` | 0.048 | 0 | 2759 |
| 13:14:28Z | agy `-h` | 0.048 | 0 | 2759 |
| 13:14:28Z | gemini `--version` | 0.834 | 7 | 0 |
| 13:14:29Z | gemini `--help` | 0.777 | 3989 | 0 |
| 13:14:30Z | gemini `-h` | 0.768 | 3989 | 0 |
| 13:15:46Z | codex `help debug` / `debug --help` | 0.013 / 0.011 | 1054 | 0 |
| 13:15:46Z | codex `help exec` / `exec --help` | 0.011 / 0.010 | 3887 | 0 |
| 13:15:46Z | codex `help features` / `features --help` | 0.010 / 0.010 | 1041 | 0 |
| 13:15:46Z | grok `help models` / `models --help` | 0.041 / 0.009 | 584 | 0 |
| 13:15:46Z | grok `help inspect` | 0.010 | 675 | 0 |
| 13:15:46Z | agy `help` | 0.406 | 0 | 2759 |
| 13:15:47Z | agy `help models` / `models --help` | 0.052 / 0.050 | 0 | 97 |
| 13:15:47Z | agy `help changelog` | 0.048 | 0 | 111 |
| 13:15:47Z | gemini `gemma --help` | 0.696 | 478 | 0 |
| 13:15:48Z | claude `auto-mode --help` | 0.422 | 706 | 0 |
| 13:16:29Z | codex `debug models --help` / `help debug models` | 0.012 / 0.011 | 914 | 0 |
| 13:16:29Z | codex `features list --help` | 0.010 | 836 | 0 |
| 13:17:13Z | codex `debug models --bundled` | 0.017 | 517840 | 0 |

Byte sizes in the table are from the first write of each capture (help text may include a trailing newline difference of a few bytes vs later copies).

---

## 7. Appendix — help / catalog excerpts (truncation named)

### 7.1 claude `--help` (21393 bytes total; effort + model lines only)

```
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name (e.g.
                                        'claude-fable-5').
```

Commands listed include `agents`, `attach`, `auth`, `auto-mode`, `doctor`, `gateway`, `import`, `install`, `logs`, `mcp`, `plugin`, `project`, `respawn`, `rm`, `setup-token`, `stop`, `ultrareview`, `update` — **no `models`**. Remainder of `--help` omitted.

### 7.2 agy `--help` (stderr 2759 bytes; effort + models lines)

```
  --effort                        Reasoning effort for the current CLI session (low|medium|high)
  --model                         Model for the current CLI session
Available subcommands:
  models          List available models
```

Full stderr retained in fixture `/tmp/cp1148-e7-capture/out/agy--help.stderr.txt` (not copied in full here).

### 7.3 grok `--help` effort flag (7381 bytes total)

```
      --reasoning-effort <EFFORT>
          Reasoning effort for reasoning models
          
          [aliases: --effort]
```

`Commands:` includes `models       List available models and exit`. Remainder omitted.

### 7.4 grok shipped README table row (`~/.grok/README.md:586`)

```
| `--reasoning-effort` / `--effort <LEVEL>` | Reasoning effort (`none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; also per-model menu ids like `deep`). TUI and headless. |
```

### 7.5 gemini `--help` (3989 bytes; no effort flag). Model line:

```
  -m, --model                     Model  [string]
```

### 7.6 `codex debug models --help`

```
Render the raw model catalog as JSON

Usage: codex debug models [OPTIONS]

Options:
      --bundled
          Skip refresh and dump only the bundled catalog shipped with this binary
```

### 7.7 Bundled catalog `gpt-6-astra` effort object (from `--bundled`; other keys omitted)

```json
{
  "slug": "gpt-6-astra",
  "display_name": "GPT-6-Astra",
  "default_reasoning_level": "low",
  "supported_reasoning_levels": [
    {"effort": "low", "description": "Fast responses with lighter reasoning"},
    {"effort": "medium", "description": "Balances speed and reasoning depth for everyday tasks"},
    {"effort": "high", "description": "Greater reasoning depth for complex problems"},
    {"effort": "xhigh", "description": "Extra high reasoning depth for complex problems"},
    {"effort": "max", "description": "Maximum reasoning depth for the hardest problems"},
    {"effort": "ultra", "description": "Maximum reasoning with automatic task delegation"}
  ]
}
```

Full dump 517840 bytes, sha256 `32bdd1fe3ffd82df3d03c6c9b9d9068087cd9640ded4377f604586d7a743749b`, fixture path `/tmp/cp1148-e7-capture/out/codex-debug-models--bundled.stdout.txt` (not committed; this report keeps the effort-relevant subset).

---

## 8. Unmeasured / next measurement (not this builder)

- Provider primary documentation for each (binary, version, model) tuple — **not measured in E7-local**.
- Whether `model_reasoning_effort` (repo argv / binary strings) is the same wire as catalog `supported_reasoning_levels[].effort`.
- Whether a help-accepted token is applied to the declared model.
- `grok models` / `agy models` live lists (help did not prove offline).
- Effective live `AIGENTRY_*` overrides vs declared defaults.
- User quality-first vs balanced policy (explicitly out of scope; no live default was changed).
