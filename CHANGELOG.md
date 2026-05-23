# Changelog

All notable changes to the aigentry-orchestrator harness are recorded here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
the repo does not version itself yet (orchestrator versioning policy TBD),
so entries are grouped under a dated `## [<YYYY-MM-DD>]` section beneath the
ongoing `## [Unreleased]` working set.

## [Unreleased]

### Added

- **`@aigentry/logger` emit wiring at dispatch + inject-handler sites (#440).**
  New `src/telemetry/logger-emit.ts` wrapper exposes typed A1 helpers
  (`emitLifecycleEvent`, `emitDispatchEvent`, `emitReportEvent`) that map
  spec event names onto the closed ssot `TelemetryEventKind` enum via
  `payload.subtype` discrimination — no ssot bump. New
  `bin/emit-telemetry.mjs` CLI shim lets bash callers invoke the helpers
  without `node -e` heredoc inlining.
  - `bin/dispatch.sh` → `state-change`/`dispatch_start` after sid is
    resolved, `state-change`/`dispatch_ack` after successful inject +
    tracker append (correlated by target sid).
  - `bin/inject-handler.sh` → five per-kind emit calls covering
    REPORT / CLEANUP_REQUEST / EXTEND_LIFETIME (defer + cancel branches) /
    HOLD / TEST_REPORT envelopes.
  Wrapper falls back to `AIGENTRY_SESSION_ID=pid-${pid}` and
  `AIGENTRY_ROLE='orchestrator'` (the repo's natural Role enum value)
  when env is unset. Honors `AIGENTRY_LOGGER_DISABLED=1` and swallows
  all transport failures (§9 독립). ADR-MF #9
  `src/telemetry/spawn-events.ts` is **untouched** (decision C3 per
  #440 ACK — orchestrator's existing spawn-events emit remains the
  authoritative source for the spawn gate; consolidation deferred).
- **Wrapper unit tests** at `tests/telemetry/logger-emit.test.ts`
  (9 cases). End-to-end smoke: emit shim produced a schema-valid
  NDJSON line in `~/.aigentry/telemetry/`. Two pre-existing failures in
  `warn-mode-telemetry.test.js` / `warn-mode.test.js` (spawn-telemetry-
  report.sh aggregation path) confirmed unrelated to #440 via baseline
  `git stash` run.

## [2026-05-23] — R2 lifecycle 3-layer + R5a TestReport handoff

### Added
- **Session lifecycle 3-layer cleanup landed (#433, ADR 2026-05-20).** Owner-initiated
  cleanup with two safety nets, per the production patterns surveyed in
  `docs/reports/2026-05-20-session-mgmt-benchmark.md`:
  - **Layer A (worker self-declared).** Worker emits `REPORT: ...-DONE`, then after a
    30s grace emits `CLEANUP_REQUEST: <sid> | reason: ...`. The new `bin/dispatch.sh`
    `--keep-alive` flag opts a session out of Layer A (reusable workers, SPEC FIRST
    re-dispatch). The flag is persisted in `state/dispatch/active.json` as a boolean
    field and honored by every downstream layer.
  - **Layer D (orchestrator timeout fallback).** `bin/dispatch-cleanup-scheduler.sh`
    `schedule | cancel | defer | tick | list` maintains
    `state/dispatch/cleanup-pending.json` (atomic tmpfile+mv writes per pattern
    introduced in #114) with the schema
    `{sid, report_time, scheduled_cleanup_time, source: "layer-d-timeout" | "reconciler" | "explicit-request", preempt_reason?}`.
    Auto-armed by `bin/dispatch-tracker.sh mark-reported`; tick AT deadline invokes
    `bin/session-cleanup.sh <sid>` once (idempotent). `EXTEND_LIFETIME` envelopes
    cancel (no `defer_minutes`) or push the deadline. Skips entries flagged
    `keep_alive: true`.
  - **Layer Reconciler (level-triggered safety net).** `bin/session-reconciler.sh`
    runs every 60s via launchd. GC root = `active.json` LIVE-status entries ∪
    `{orchestrator}` (PROTECTED) ∪ `keep_alive` sids. Candidate sweep set =
    `telepty list` minus GC root, gated by `RECONCILER_AGE_FLOOR` (default 300s,
    anti-spawn-race floor) and dead-PID / `DISCONNECTED` for
    `RECONCILER_DISCONNECT_FLOOR` (default 240s). Per-sid exponential backoff in
    `state/dispatch/reconciler-backoff.json` (initial 5s, max 1000s — controller-runtime
    defaults). First step of every tick is `dispatch-cleanup-scheduler.sh tick`,
    so Layer D fires on the reconciler cadence as well.
- **`bin/lib/workspace-host.sh` adapter seam (ADR 2026-05-20 §Consequences).**
  Four-method contract — `wh_lookup` / `wh_close` / `wh_alive` / `wh_list_ids` —
  with cmux + headless adapters shipped together. Auto-select via
  `AIGENTRY_WORKSPACE_HOST` env or PATH heuristic. `bin/session-cleanup.sh` now
  routes through the seam (`close_workspace_for`) instead of hardcoding
  `cmux close-workspace`; headless is the documented degrade path for
  CI/docker/windows-terminal/zellij hosts.
- **`@aigentry/ssot` consumed via `file:` import.** Orchestrator `package.json` now
  declares `"@aigentry/ssot": "file:../aigentry-ssot/pkg"`; `npm install` symlinks
  `node_modules/@aigentry/ssot → ../aigentry-ssot/pkg`. Local path only — no registry
  dependency (Constitution §17 무의존). Pin matches ssot tag `v1.0.0-rc.0`
  (commit `7e44974`).
- **`src/session/inject-parser.ts` envelope parser.** Thin wrapper over
  `parsePtyEnvelope` from `@aigentry/ssot/envelope/pty-envelope`. Recognizes five
  envelope kinds — `report`, `hold`, `cleanup-request`, `extend-lifetime`,
  `test-report` — across both transports (fenced JSON `\`\`\`json aigentry-envelope/v1`
  and markdown line fallback). Backward-compatible with the pre-envelope markdown
  REPORT / HOLD shape; markdown forms for the three new kinds are documented in the
  module header. 18 unit tests cover positive/negative paths and the
  fenced→markdown precedence rule.
- **R5a tester→orchestrator handoff (#436).** `bin/inject-handler.sh` parses an
  inbound inject body (stdin or `--body-file`) and dispatches per kind:
  - `report` → `dispatch-tracker.sh mark-reported`
  - `cleanup-request` → scheduler `schedule --source explicit-request`
  - `extend-lifetime` → scheduler `defer` or `cancel`
  - `hold` → append to `state/dispatch/holds.log`
  - `test-report` → atomic write to `state/test-reports/<YYYY-MM-DD>/<sid>.json`
    (ssot `TestReport` schema, `_transport` field preserved for audit). Malformed
    envelopes are rejected without silent acceptance.
  `docs/templates/dispatch-ref-template.md` gains a `Tester role REPORT format`
  section with both transports + the ssot field-semantics index.
- **Integration tests.** `tests/dispatch/T17_lifecycle_3layer.sh` exercises four
  scenarios — Layer A success, Layer D timeout, EXTEND_LIFETIME defer / cancel,
  Reconciler crash sweep with `RECONCILER_AGE_FLOOR=10` override — plus the
  keep-alive opt-out across paths. `tests/dispatch/T18_test_report_handoff.sh`
  covers both TestReport transports + the negative path. Five additional unit-style
  tests (`T19`–`T23`) pin scheduler schedule / cancel / defer / tick, keep-alive
  short-circuit, reconciler GC root computation, and the workspace-host adapter
  contract. `T24` covers the inject-handler test-report write end-to-end.
- **`~/Library/LaunchAgents/com.aigentry.reconciler.plist`.** `StartInterval=60`,
  `RunAtLoad`, stdout/stderr to `~/Library/Logs/aigentry-orchestrator/reconciler.log`.
  `plutil -lint OK`. **Not auto-loaded** — operators run
  `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.aigentry.reconciler.plist`
  once. Linux systemd equivalent is registered as a follow-up task (cross-platform §2).

### Notes
- Pre-existing test baseline before this changeset: 185 TS tests with 2 failures
  in `spawn-telemetry-report.sh` (`W4 — composed-stack events aggregate` and
  `report.sh aggregation (12)`). Both are unrelated to this change — verified by
  running the suite without the new files. They remain on the failure list and
  are NOT touched by this changeset.
- All new TypeScript passed `mcp__snyk__snyk_code_scan` with 0 findings.

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
