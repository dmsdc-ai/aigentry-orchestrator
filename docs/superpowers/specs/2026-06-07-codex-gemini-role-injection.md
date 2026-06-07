# Spec — codex / gemini role-injection via cwd context files (#532, #531 epic)

- **Status**: SPEC FIRST (Rule 24). NO code, NO commit this wave. Impl gated on `532-APPROVED`
  + sequencing (lands **after** `coder-hygiene`'s `bin/` edits — same-repo git-race avoidance, §6).
- **Author**: coder-532 · **Date**: 2026-06-07 · **Repo**: `aigentry-orchestrator` (branch `main`)
- **Approach** (orchestrator decision, Art.1 경량): **ADDITIVE** — stage the role prompt as a cwd
  context file the CLI auto-discovers (`AGENTS.md` for codex, `GEMINI.md` for gemini), mirroring
  claude's role isolation. NOT the full-override paths (`model_instructions_file` /
  `GEMINI_SYSTEM_MD`) — those stay documented fallbacks for a future "hard role" need (§7).
- **Evidence base**: research `~/.aigentry/role-sandbox/researcher-dustcraw-532/findings-532-role-injection.md`
  + local binary inspection this wave (codex 0.133.0, gemini 0.42.0). All claims below were verified
  against the installed CLIs, not just docs.

---

## 0. Problem (#532)

`bin/boot-prepare.mjs` (`--role`, ADR-MF #13 / #431) delivers a role system-prompt to **claude** via
`claude --append-system-prompt-file <staged>` + an isolated role-sandbox cwd (so the worker skips the
project's `CLAUDE.md` auto-discovery). codex and gemini ship **no `--append-system-prompt` flag**
(verified: §1.2), so `boot-prepare.mjs` hard-rejects them (`bin/boot-prepare.mjs:253-258`) and the
orchestration step "match CLI to task (claude/codex/gemini)" is claude-only. This spec closes the gap
**without an upstream flag** by exploiting each CLI's cwd context-file auto-discovery.

---

## 1. Findings — exactly what the installed CLIs support (verified this wave)

### 1.1 Current claude wiring (the machinery to REUSE — DRY, §1 of dispatch)

Trace of the claude path that codex/gemini must mirror:

1. `bin/dispatch.sh:303-317` — when `cli=claude` **and** `--role` set, runs
   `node boot-prepare.mjs --role <r> --cwd <project> --sid <sid> --cli claude`, then parses
   `spawn_cli` (a per-session `launcher.sh`) + `spawn_cwd` (the sandbox dir) from its JSON stdout.
2. `bin/boot-prepare.mjs`:
   - `main()` rejects any `--cli` ≠ `claude` at **`boot-prepare.mjs:253-258`** (the gate this spec lifts).
   - Builds sandbox cwd `$HOME/.aigentry/role-sandbox/<role>-<sid>/` (`:286-294`) — a fresh dir with
     **no `CLAUDE.md`**, so claude's cwd-ancestry memory discovery finds nothing.
   - `ensureSandboxTrusted(sandboxCwd)` (`:147-201`, called `:294`) writes
     `hasTrustDialogAccepted:true` into `~/.claude.json` so the fresh dir skips claude's trust modal.
   - `resolveInstructions({role, cwd:sandboxCwd, …})` (`:297-305`) composes the layered prompt
     (common + role + …); the boot adapter writes it to `<stagingDir>/effective_prompt.md`
     (`common.ts:76-77`, `canonicalBytes(resolved.effective_prompt)`).
   - `buildSessionContract(...)` text is **appended** to that file (`:339-347`) — documents role +
     sandbox cwd + `AIGENTRY_TARGET_CWD`.
   - Emits a per-session `launcher.sh` (`:368-378`) whose body is:
     `export AIGENTRY_TARGET_CWD=<project>` then `exec -a claude claude <staged-flags> "$@"`.
     The `-a claude` keeps argv[0]=`claude` so `telepty list` / `is_ready` see the right CLI name.
   - Returns `{spawn_cli: launcherPath, spawn_cwd: sandboxCwd, env:{AIGENTRY_TARGET_CWD}}`.
3. `bin/dispatch.sh:322-333` — wraps `spawn_cli` in `write_worker_launcher` (git-push guard) with
   **display_cli hardcoded `"claude"`** (`:327`), then `open-session.sh --cli <worker_launcher>
   --cwd <sandbox>` spawns it in the detected terminal (cmux/aterm/tmux/…).

**Why the sandbox cwd already defeats the *project*-file leak:** the sandbox lives under
`$HOME/.aigentry/role-sandbox/…`, which is **not** an ancestor of the project tree. codex walks
`AGENTS.md` from a repo root down to cwd; gemini walks `GEMINI.md` up the cwd ancestry — neither can
reach `aigentry-orchestrator/AGENTS.md` (20 KB, exists) or `…/GEMINI.md` (403 B, exists) from a
sandbox cwd outside that tree. So the **same sandbox-cwd machinery** that protects claude also
protects codex/gemini from project context. The *only* residual leak is the per-user **global**
context file (§3).

### 1.2 codex 0.133.0 — no flag; additive path = cwd `AGENTS.md`

- `codex --help` / `codex exec --help`: **no** `--system-prompt`, `--append-system-prompt`,
  `--instructions`, `--developer-message`. Present: `-c/--config <key=value>`, `-C/--cd <DIR>`,
  `-p/--profile`, `--profile-v2`, `--enable/--disable <feature>`, `--add-dir`.
- **Auto-discovers `AGENTS.md`** in the working-dir tree (binary: `codex_core::agents_md`, scopes
  `Global` @ `core/src/agents_md.rs:129`, `Project` @ `:270`; also reads `AGENTS.override.md`),
  injected **additively** over `base_instructions`. → stage `<sandbox-cwd>/AGENTS.md`.
- Config home = `CODEX_HOME` env, default `~/.codex` (binary:
  `os.environ.get("CODEX_HOME", os.path.expanduser("~/.codex"))`). Holds **`auth.json`** (OAuth),
  `config.toml`, `skills/`, **and the global `AGENTS.md`** (`Global` scope = `$CODEX_HOME/AGENTS.md`).
- Full-override fallback (NOT chosen): `-c model_instructions_file=<file>` replaces `base_instructions`.

### 1.3 gemini 0.42.0 — no flag; additive path = cwd `GEMINI.md`

- `gemini --help`: **no** `--system` / `--system-instruction`. Present: `-p/--prompt`,
  `--include-directories`, `--policy`, `-m/--model`, `--approval-mode`, **`--skip-trust`**.
  (The existing `gemini.ts` `--system` + `--workspace-root` flags **do not exist** — §8.)
- **Auto-discovers `GEMINI.md`** hierarchically (binary: `contextFileName` default `"GEMINI.md"`),
  merged **additively** as memory/context. → stage `<sandbox-cwd>/GEMINI.md`.
- Config home = **`GEMINI_CLI_HOME`** env, default `~/.gemini` (binary, single `homedir()` site:
  `const baseDir = process.env["GEMINI_CLI_HOME"] || join(os.homedir(), ".gemini")`). Holds
  `settings.json`, OAuth creds (`oauth_creds.json`), **and the global `GEMINI.md`**.
- Full-override fallback (NOT chosen): `GEMINI_SYSTEM_MD=<file>` replaces the built-in system prompt
  (note: it does **not** stop `GEMINI.md` memory loading, so it does not by itself fix the §3 leak).

### 1.4 Per-CLI summary table

| CLI    | additive context file (staged in sandbox cwd) | config-home env (redirect target, §3) | trust-skip | default flags (existing) |
|--------|-----------------------------------------------|---------------------------------------|------------|--------------------------|
| claude | (n/a — `--append-system-prompt-file`)         | (n/a)                                 | `~/.claude.json` auto-trust | `--permission-mode bypassPermissions` |
| codex  | `AGENTS.md`                                    | `CODEX_HOME`                          | see §3.3 (verify) | `-c check_for_update_on_startup=false --dangerously-bypass-approvals-and-sandbox` |
| gemini | `GEMINI.md`                                    | `GEMINI_CLI_HOME`                     | `--skip-trust` | `-m gemini-3.1-pro-preview --approval-mode yolo` |

---

## 2. Per-CLI staging (Spec item 2)

**Content source = identical to claude's.** boot-prepare already produces the staged
`effective_prompt.md` = `canonicalBytes(resolved.effective_prompt)` + appended session contract
(`boot-prepare.mjs:339-347`). For codex/gemini, **after** that append, copy that exact file to the
sandbox cwd under the CLI's recognized context filename:

- codex → `<sandboxCwd>/AGENTS.md`
- gemini → `<sandboxCwd>/GEMINI.md`

So the role prompt the codex/gemini worker reads is byte-identical to claude's (same layers, same
session contract). No second source of truth.

**Where the branch goes in boot-prepare.mjs:**

1. **Lift the gate** at `boot-prepare.mjs:253-258`: replace the `args.cli !== "claude"` hard-fail with
   acceptance of `claude | codex | gemini` (reuse `isCliKind`, already imported transitively via
   `types.js`; or an inline allowlist). Reject anything else with the same clear non-zero exit.
2. **Introduce a per-CLI descriptor table** (Art.1: one small literal, no new abstraction layer):
   ```js
   const CLI_INJECT = {
     claude: { contextFile: null,         homeEnv: null,             // flag-based; unchanged
               exec: 'claude' },
     codex:  { contextFile: 'AGENTS.md',  homeEnv: 'CODEX_HOME',
               exec: 'codex'  },
     gemini: { contextFile: 'GEMINI.md',  homeEnv: 'GEMINI_CLI_HOME',
               exec: 'gemini' },
   };
   ```
3. **Stage the context file** (codex/gemini only), right after the `appendFile(cmd.prompt_file, …)`
   at `:347`: `await copyFile(cmd.prompt_file, join(sandboxCwd, CLI_INJECT[cli].contextFile))`.
   (Sandbox dir already `mkdir -p`'d at `:293`.)
4. **Parameterize the session contract** (`buildSessionContract`, `:203-223`): its wording is
   claude-specific ("claude reads it via `--append-system-prompt-file`", "any per-project
   `CLAUDE.md`"). Make it CLI-neutral or pass `cli` so it says the equivalent for codex (`AGENTS.md`)
   / gemini (`GEMINI.md`). Surgical: a single conditional noun, not a rewrite.

**The boot-adapter `buildArgvEnv` for codex/gemini is NOT used on this additive path** — those
return flag/env wiring that the additive design does not emit. boot-prepare drives the launcher
directly (as it already does for claude). See §8 for reconciling the now-misleading adapter exports.

---

## 3. Global-file leak neutralization (Spec item 3 — critical)

### 3.1 The leak

After §1.1 (sandbox cwd) the *project* files cannot load. What remains:

- codex reads **`$CODEX_HOME/AGENTS.md`** (`Global` scope) → today `~/.codex/AGENTS.md` (0 B now,
  but user-mutable; must be neutralized regardless).
- gemini reads **`$GEMINI_CLI_HOME/GEMINI.md`** → today `~/.gemini/GEMINI.md` (**339 B, non-empty —
  a real, present leak**).

A worker inheriting these defeats role isolation.

### 3.2 Chosen mechanism — config-home redirect with selective symlink mirror

**Decision (lightest *reliable*):** redirect each CLI's config-home env to a **per-session sandbox
config home** that mirrors the real home via symlinks of every top-level entry **except** the global
context file(s). Concretely, in boot-prepare for codex/gemini:

```
homeReal   = CODEX_HOME?? ~/.codex     (codex)  |  GEMINI_CLI_HOME?? ~/.gemini  (gemini)
homeShadow = <sandboxCwd>/.<cli>home            // e.g. <sandbox>/.codexhome
for each entry E in readdir(homeReal):
    if E in EXCLUDE:  continue                  // codex: AGENTS.md, AGENTS.override.md
                                                // gemini: GEMINI.md
    symlink(join(homeReal,E), join(homeShadow,E))
export <homeEnv> = homeShadow                   // in the launcher
```

**Why this and not the alternatives:**

- **vs. plain `CODEX_HOME=<empty dir>` / `GEMINI_CLI_HOME=<empty dir>`:** an empty home **breaks
  auth** — `auth.json` (codex) / `oauth_creds.json` (gemini) live in that dir. An auth break is a
  *hard* failure (worker can't start) — strictly worse than a *soft* context leak. The mirror keeps
  auth + settings + skills intact while shadowing only the doc. (Verified both creds live under the
  config home.)
- **vs. a `-c` config key disabling the global doc (codex):** none found in the 0.133.0 binary that
  selectively disables the `Global` AGENTS.md. `project_doc_max_bytes` caps **all** docs including
  *ours* → unusable. So no flag-only codex option exists.
- **vs. `GEMINI_SYSTEM_MD` (gemini):** overrides the *system prompt*, not the `GEMINI.md` *memory*
  file → does not stop the leak; also it's the rejected full-override path.
- **vs. `contextFileName` workspace-settings rename (gemini-only):** viable but CLI-specific, key
  shape varies by version, and gives no uniform codex story. The home-redirect is **one uniform
  pattern across both CLIs** — Art.1 friendly.

**Cost:** one `readdir` + N `symlink`s at boot (cheap; N = handful of entries). Auth/config/skills
fully preserved. **Graceful degradation:** if a future CLI version adds a new global context
filename not in `EXCLUDE`, it re-leaks (soft) rather than breaking auth (hard) — flag `EXCLUDE` with
a maintenance comment so it tracks upstream filename changes.

### 3.3 Trust-prompt neutralization (parallels claude's `ensureSandboxTrusted`)

- gemini: pass **`--skip-trust`** (exists, §1.3) in the launcher's flags → no trust modal for the
  fresh sandbox cwd.
- codex: `--dangerously-bypass-approvals-and-sandbox` is already a default flag; **verify in the
  test plan** (§5) whether codex still shows a folder-trust prompt for the fresh sandbox dir. If it
  does, set the trust in the shadow `CODEX_HOME/config.toml` (e.g. `projects.<sandbox>.trust_level`)
  at boot — analogous to claude's `~/.claude.json` write. Do not assume; gate on the live check.

---

## 4. Launch invocation (Spec item 4) — exact argv + env per CLI

boot-prepare emits a per-session `launcher.sh` (generalize `:368-378`). The launcher's `exec` line
and exported env become CLI-specific via `CLI_INJECT[cli]`:

**codex** (`spawn_cwd = sandboxCwd`):
```bash
export AIGENTRY_TARGET_CWD=<project>
export CODEX_HOME=<sandboxCwd>/.codexhome           # §3.2 shadow home (mirror minus AGENTS.md)
exec -a codex codex -c check_for_update_on_startup=false \
                    --dangerously-bypass-approvals-and-sandbox "$@"
# role prompt delivered by <sandboxCwd>/AGENTS.md auto-discovery (additive)
```

**gemini** (`spawn_cwd = sandboxCwd`):
```bash
export AIGENTRY_TARGET_CWD=<project>
export GEMINI_CLI_HOME=<sandboxCwd>/.geminihome     # §3.2 shadow home (mirror minus GEMINI.md)
exec -a gemini gemini -m gemini-3.1-pro-preview --approval-mode yolo --skip-trust "$@"
# role prompt delivered by <sandboxCwd>/GEMINI.md auto-discovery (additive)
```

Notes:
- **Do NOT pass codex `-C/--cd <project>` or gemini `--include-directories <project>`** at boot —
  the worker `cd $AIGENTRY_TARGET_CWD` itself when it needs the project (exactly as claude does).
  Passing the project cwd would re-expose the project's `AGENTS.md`/`GEMINI.md` (re-leak). The
  sandbox stays the process cwd for the whole boot.
- `exec -a <cli>` keeps argv[0] = `codex`/`gemini` so `telepty list` / `dispatch.sh:is_ready`
  prompt-symbol probe (codex `›`, gemini `›|│ >`) resolve correctly.
- **`--bare`-equivalent isolation?** Neither CLI has one. The achieved isolation = sandbox cwd (no
  project ancestry) + config-home redirect (no global doc) + additive staged file. Document this as
  the codex/gemini analog of claude's hybrid (b-2)+(c).

**dispatch.sh edits (same repo, part of impl surface):**
- `dispatch.sh:303` — extend the gate `[ "$cli" = "claude" ] && [ -n "$role" ]` to
  `claude|codex|gemini`. (Suggest a `case "$cli" in claude|codex|gemini)` guard.)
- `dispatch.sh:327` — `write_worker_launcher "$sid" "claude" …` hardcodes display_cli; change the
  2nd arg to `"$cli"` so the git-guard wrapper's `exec -a <cli>` and telepty visibility are correct.

---

## 5. aterm/cross consistency + Test plan (Spec item 5, Art.2)

**Cross-host:** `open-session.sh` already spawns `--cli <worker_launcher> --cwd <spawn_cwd>` through
the detected terminal (cmux/aterm/tmux/wezterm/iterm/generic) CLI-agnostically (`open-session.sh:211-273`);
the launcher carries env + cwd via `bash -c 'cd $cwd && exec …'`. Because boot-prepare returns the
same `{spawn_cli, spawn_cwd}` shape for codex/gemini, **no per-terminal change is needed** — behavior
stays consistent across hosts. Verify on at least cmux (primary) + one fallback (tmux or aterm).

**Live test plan (must pass before DONE):**

1. **Role receipt — codex:** dispatch a codex worker with a role whose prompt contains a unique
   sentinel (e.g. a role marker line); inject "state your role + the sentinel". Assert the worker
   echoes the role/sentinel → staged `AGENTS.md` was read.
2. **Role receipt — gemini:** same with a gemini worker → staged `GEMINI.md` was read.
3. **Project isolation:** put a detectable canary line in `aigentry-orchestrator/AGENTS.md` and
   `…/GEMINI.md`; assert neither worker reproduces the canary (sandbox cwd blocks project ancestry).
4. **Global isolation:** put a canary in `~/.codex/AGENTS.md` and `~/.gemini/GEMINI.md`; assert
   neither worker reproduces it (config-home redirect, §3.2).
5. **Auth survives redirect:** assert each worker actually reaches its model (a trivial round-trip),
   proving the symlink mirror preserved `auth.json` / `oauth_creds.json`.
6. **codex folder-trust check (§3.3):** confirm whether the fresh sandbox triggers a codex trust
   modal; if so, the boot must pre-trust it. Record the verdict.
7. **codex cwd-`AGENTS.md` without git:** the sandbox is not a git repo — confirm codex loads a cwd
   `AGENTS.md` outside any git root (research says yes "anywhere in the tree"; verify empirically,
   else fall back to `git init -q` in the sandbox or `project_doc_fallback_filenames`).

---

## 6. Sequencing (Spec item 6 — HARD)

Impl edits `bin/boot-prepare.mjs` **and** `bin/dispatch.sh` (orchestrator repo). `coder-hygiene` is
concurrently editing `bin/` in the same repo. **This impl MUST land AFTER `coder-hygiene`'s `bin/`
changes** to avoid a same-repo git race (Rule 29 surgical + clean rebase). This spec doc itself is a
disjoint new path (`docs/superpowers/specs/…`) and is **not committed** this wave.

Impl surface (for the post-APPROVED wave), all surgical (Rule 29):
- `bin/boot-prepare.mjs`: lift gate `:253-258`; add `CLI_INJECT` table; copy staged prompt →
  `<sandbox>/{AGENTS,GEMINI}.md`; build §3.2 shadow home + symlink mirror; generalize launcher
  `exec`/env `:368-378`; parameterize `buildSessionContract` `:203-223`.
- `bin/dispatch.sh`: extend gate `:303`; parameterize display_cli `:327`.
- `src/session/boot-adapter/{codex,gemini}.ts` + `index.ts`: see §8 (reconcile fictional exports) —
  optional this impl, but recommended same-PR to avoid leaving a false API surface.

---

## 7. Documented fallback (NOT implemented now)

For a future "hard role" need (full system-prompt replacement, not additive):
- codex: `-c model_instructions_file=<staged-role.md>` (replaces `base_instructions`).
- gemini: `GEMINI_SYSTEM_MD=<staged-role.md>` env (replaces built-in system prompt).
Keep as documented escape hatch; the additive path is the default (Art.1, preserves base CLI behavior).

## 8. Reconcile the existing (fictional) boot adapters

`src/session/boot-adapter/codex.ts` and `gemini.ts` (and their re-exports in `index.ts:41-48`)
declare wiring that **does not exist in the shipped CLIs**, and is **not** what the additive design
emits:
- `codex.ts`: `CODEX_NO_CONTEXT_AUTOLOAD` / `CODEX_SYSTEM_PROMPT_FILE` env (no such env in 0.133.0);
  `--cd` is real but unused on the additive path (we keep cwd=sandbox, §4).
- `gemini.ts`: `--system` and `--workspace-root` flags (neither exists in 0.42.0; real flag is
  `--include-directories`, and there is no system-prompt flag).

Because the additive path is driven by boot-prepare (not `buildArgvEnv`), these exports are dead/false
API. Recommended (same impl PR, surgical): rewrite both adapters to the additive contract — i.e.
encode `{contextFile, homeEnv, default flags}` so the per-CLI knowledge lives in the adapter (DRY)
and boot-prepare consumes it, replacing the inline `CLI_INJECT` table in §2. If kept out of scope for
sequencing, at minimum delete/`UPSTREAM-GAP`-mark the fictional constants so no caller trusts them.
This is flagged, not silently changed (Rule 29) — orchestrator decides whether it rides this wave.

---

## REPORT
Spec complete, not committed. Awaiting `532-APPROVED` before any code (Rule 24). On approval, impl is
sequenced after `coder-hygiene` (§6).
