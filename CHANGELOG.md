# Changelog

All notable changes to the aigentry-orchestrator harness are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the repo does not version itself yet (orchestrator versioning policy TBD),
so entries are grouped under a dated `## [<YYYY-MM-DD>]` section beneath the
ongoing `## [Unreleased]` working set.

## [Unreleased]

## [2026-05-23]

### Fixed
- **cwd→role contamination at process-spawn boundary (#431, ADR 2026-05-12 enforcement).**
  Sessions spawned via `bin/dispatch.sh --spawn-and-dispatch` in another
  project's cwd (e.g. `/Users/.../aigentry-orchestrator`) absorbed the cwd's
  `CLAUDE.md` during claude's auto-discovery — self-identifying as orchestrator
  for ~minute(s) until an explicit role-corrective inject landed. Triggered by
  the 2026-05-23 `agentic-dustcraw-standards` incident. ADR-MF #4 +
  ADR-MF #13 had the design but `dispatch.sh` was shelling to
  `aigentry-devkit/bin/open-session.sh` with `claude --permission-mode
  bypassPermissions` (no `--bare`, no `--system-prompt-file`).

### Added
- **`bin/boot-prepare.mjs` (new, executable, ESM, stdlib-only).** Bridges
  `dispatch.sh` ↔ `src/session/boot-adapter/` (ADR-MF #13). Computes a
  per-session sandbox cwd `$HOME/.aigentry/role-sandbox/<role>-<sid>/`,
  ensures `~/.aigentry/instructions/` populated (auto-runs
  `bin/install-instructions.sh`), auto-trusts the sandbox in `~/.claude.json`,
  resolves the layered effective_prompt (common + role + task — the task layer
  is empty for boot; dispatch ref is injected separately), appends a
  documented session-boot-contract block, writes a per-session `launcher.sh`
  that exports `AIGENTRY_TARGET_CWD` and `exec`s claude with the staged flags,
  and emits JSON `{spawn_cli, extra_flags, spawn_cwd, env}` on stdout. Failure
  exits non-zero with a clear stderr message — never silently emits a broken
  contract.
- **`bin/dispatch.sh` `--role` flag.** When `--spawn-and-dispatch --cli claude
  --role <role>` is supplied, invokes `boot-prepare.mjs`, parses the JSON, and
  spawns via `open-session.sh --cwd <sandbox> --cli <launcher>`. Failure of
  `boot-prepare.mjs` emits a stderr WARNING and falls back to the legacy spawn
  path (no silent failure). Backward-compatible: omitting `--role` preserves
  the previous spawn behavior bit-for-bit.
- **`tests/session/boot-prepare.test.ts` (new, 9 hermetic tests).** Verifies
  launcher.sh executable + uses `--append-system-prompt-file` (not `--bare`)
  + role layer composes into effective_prompt + decoy cwd CLAUDE.md MARKER is
  never present in the staged prompt + sandbox path under role-sandbox/ has no
  CLAUDE.md + AIGENTRY_TARGET_CWD env exported with the caller's `--cwd` value
  + session-contract preamble references sandbox/target paths + codex/gemini
  rejected (UPSTREAM-GAP deferred) + unknown role rejected + missing-arg exits 4.
- **`tests/dispatch/T16_no_cwd_contamination.sh` (new, live integration).**
  Spawns a real claude worker via real `dispatch.sh --spawn-and-dispatch`
  with `--cwd $REPO_ROOT --role coder`. Asserts staged effective_prompt is
  role-only + no orchestrator AGENTS.md leakage + launcher.sh wires
  `--append-system-prompt-file` and not `--bare` + claude process cwd is the
  sandbox (`lsof`) + `AIGENTRY_TARGET_CWD` is in claude's process env
  (`ps eww`) + sandbox has no CLAUDE.md + worker self-identifies as coder in
  screen + no orchestrator-self-id keyword present. Skips gracefully when
  `claude` / `telepty` / `node` / `python3` / `dist/` are missing (CI).
  Picked up automatically by `tests/dispatch/run-all.sh` `T*.sh` glob.

### Changed
- **`src/session/boot-adapter/claude.ts` argv (Rule 29 surgical).** Replaced
  `["claude","--bare","--system-prompt-file",prompt_file]` with
  `["claude","--append-system-prompt-file",prompt_file]`. The original `--bare`
  design was auth-incompatible with OAuth/keychain users (per claude's own
  `--help`: *"Anthropic auth is strictly ANTHROPIC_API_KEY or apiKeyHelper via
  --settings (OAuth and keychain are never read)."* Empirical probe under the
  deployed user's OAuth returned "Not logged in"). The cwd→role contamination
  is closed instead by the hybrid (b-2)+(c) approach: system-prompt-level role
  override (this flag) + sandbox cwd (`bin/boot-prepare.mjs`, where the project
  CLAUDE.md cannot be auto-discovered).
- **`bin/dispatch.sh` `is_ready` regex.** Widened the placeholder/prompt
  search from `last3` (last 3 non-empty lines) to the whole captured `tail`.
  Claude 2.x renders status bars (bypass-permissions, context-budget, MCP
  notices) BELOW the prompt area, so the prompt sits in the upper-tail and the
  previous narrow search returned not-ready indefinitely for fresh sessions.
  `HARD_NEG` (Working…/Thinking) still checks `last3` only — those signals
  are reliably the bottom-most active state.
- **`tests/session/boot-adapter/adapters.test.ts` test #3.** Updated expected
  claude argv to match the new `--append-system-prompt-file` shape, with a
  rationale comment pointing at this CHANGELOG entry + the ADR addendum.

### Security
- **Snyk At-Inception** (per `~/.claude/CLAUDE.md` global rule). TARGETED
  scan on modified TS/JS files: `src/session/boot-adapter/claude.ts`,
  `bin/boot-prepare.mjs`, `tests/session/boot-prepare.test.ts`,
  `tests/session/boot-adapter/adapters.test.ts`. Shell out of Snyk language
  scope (`bin/dispatch.sh`, `tests/dispatch/T16_…`). One LOW finding (CWE-23
  Path Traversal) on `boot-prepare.mjs` chmodSync flow — fixed by
  charset-restricting `--sid`, requiring `--cwd` to be an absolute path
  without `..`, containment-checking the launcher path against
  `$HOME/.aigentry/sessions/` via `path.resolve`, and replacing `chmodSync`
  with atomic `writeFile(path, body, { mode: 0o755 })`. Rescan: 0 findings.

### Audit (informational — no action required)
- 75 existing dispatch refs scanned for relative-path assumptions that would
  break when the worker spawns in a sandbox cwd. Result: 55 fully absolute,
  19 mention `state/X` only as label text (`path:`/backticks), 1 potentially
  relative (`2026-05-12-E-coder-mf9-warn-mode-dispatch.md` — likely also
  label), 0 require explicit `cd` to project root. Sandbox cwd has near-zero
  blast radius — no migration note added to `docs/templates/dispatch-ref-template.md`.

### Deferred
- **Codex / Gemini boot-adapter wiring.** Existing `UPSTREAM-GAP` markers in
  `src/session/boot-adapter/{codex,gemini}.ts` are preserved
  (`CODEX_NO_CONTEXT_AUTOLOAD` / `GEMINI_NO_CONTEXT_AUTOLOAD` env-var names
  remain unverified upstream). `boot-prepare.mjs` rejects `--cli codex` /
  `--cli gemini` with a clear error pointing at this dispatch's claude-only
  scope. Follow-up tasks tracked by orchestrator.
- **Sentinel cwd approach (c) standalone.** Documented in the ADR addendum
  as a fallback for environments where `--append-system-prompt-file` is not
  available. Not implemented in this dispatch.
