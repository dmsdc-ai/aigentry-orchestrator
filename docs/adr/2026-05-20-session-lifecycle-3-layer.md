---
status: accepted
date: 2026-05-20
---

# Session lifecycle — 3-layer owner-initiated cleanup

## Context

Orchestrator-spawned worker sessions (telepty session + optional cmux workspace + parent `telepty allow` PID) accumulated as **orphans** when natural termination didn't trigger cleanup. Concrete incident: 19/19 cmux workspaces left orphaned after an MD audit fan-out (2026-05-17 → 2026-05-20). Existing `bin/session-cleanup.sh` was telepty-list-driven and exited early (line 157) when the session was already gone from telepty's view — never touching cmux. Cross-platform users (ghostty/Warp/Windows Terminal/zellij/conhost/headless) had no automation path at all.

External benchmark (`docs/reports/2026-05-20-session-mgmt-benchmark.md`, ~50 sources across 5 groups) surfaced two dominant production patterns: (1) **lease-with-renewal** (etcd/Consul/DHCP — owner self-declares liveness, absence of renewal is the cleanup signal), and (2) **level-triggered reconciliation** (K8s controller pattern — periodic root-set diff, not edge-triggered event response). Multiple anti-patterns documented: no-GC-at-all (vscode#53552), edge-only without level safety net (nomad#27409), idle-alone signal as data-loss footgun (USC-HPC tmux thread).

## Decision

Session cleanup is **owner-initiated** with two safety nets — total 3 layers:

1. **Layer A (primary, owner self-declared)** — Session sends `REPORT: ...-DONE` inject when task complete, waits 30s grace, then sends `CLEANUP_REQUEST: <sid> | reason: ...` inject to orchestrator. Orchestrator validates and runs `session-cleanup.sh <sid>`. Any new inject received during grace cancels (session reused). Spawn flag `--keep-alive` opts session out of auto-`CLEANUP_REQUEST` (reusable session pattern, e.g., SPEC FIRST re-dispatch).

2. **Layer D (orchestrator timeout fallback)** — If orchestrator receives `REPORT` but no `CLEANUP_REQUEST` within 60s, orchestrator schedules cleanup itself. Honors session's logical authority — session can preempt with EXTEND_LIFETIME inject during the 60s window.

3. **Layer Reconciler (level-triggered safety net)** — Periodic (60s interval) sweep using `state/dispatch/active.json` as GC root (mark-and-sweep §5.3). Session is "live" iff it appears in dispatch_registry's active set OR is `orchestrator` (PROTECTED). Otherwise candidate for sweep, gated by `age_since_spawn > 5min` (anti-spawn-race floor), `PID_dead OR (telepty_disconnected AND disconnect_age > 4min) OR workspace_host_orphan`. Idempotent, exponentially-backed-off on cleanup failure. Catches: REPORT never sent, orchestrator inject parser bug, partial cleanup, all unhappy paths Layers A+D miss.

Workspace cleanup goes through a **Workspace Host** seam (cmux / zellij / headless / windows-terminal adapters) — `session-cleanup.sh` no longer hardcodes `cmux close-workspace`; it calls `workspace_host.close(host_id)` and the adapter knows what to do (no-op for headless).

Contract: stale sessions reaped within `reconcile_interval × 2 = 120s` upper bound (Consul "up to 2×TTL" pattern).

## Considered options (rejected)

- **Pure deadness-detection by orchestrator** (PID-probe + telepty-DISC scan): rejected — implicit "X is dead" inference is the anti-pattern (USC-HPC tmux killing detached sessions, nomad#27409). Owner-declared liveness is the production-grade pattern.

- **Layer A alone** (LLM trust): ~15% orphan rate from LLM compliance + crashes pre-REPORT. Not acceptable for "심리스" automation goal.

- **Layer A + D without Reconciler**: still leaks ~5% on REPORT-never-sent paths (task abort, claude OOM pre-REPORT, orchestrator side bugs). Anti-pattern #3 in benchmark.

- **Daemon-side TTL in telepty** (lease semantics enforced by telepty daemon): more elegant but requires telepty repo change. Registered as follow-up task; A+D+Reconciler ships in orchestrator-only Phase 1.

## Consequences

- New protocol message: `CLEANUP_REQUEST` (additive — backward compatible)
- `state/dispatch/active.json` becomes the GC root — single source of truth for "live" set. Pre-existing per Rule 32-HARD; now load-bearing for cleanup correctness.
- Dispatch ref template (`docs/templates/dispatch-ref-template.md`) gains a CLEANUP_REQUEST clause in the protocol section.
- New module: Workspace Host adapter interface — cmux is one of multiple adapters, no longer the implicit-only host.
- New module: Reconciler (`bin/session-reconciler.sh` + launchd plist for periodic firing on Mac).
- `session-cleanup.sh` refactored to consume Workspace Host adapter (no more cmux-hardcoded call) + add `--cmux-orphans` mode driven by cmux-list (handles current 22-orphan backlog one-shot).
- Telepty Layer C (universal `--enforce-cleanup-on-report` flag) registered as separate follow-up task to land later.

## Addendum — 2026-05-23

R2 + R5a impl landed via the `β1-lifecycle-handoff` dispatch
(`@aigentry/ssot` consumed by `file:../aigentry-ssot/pkg`, pin
`v1.0.0-rc.0` commit `7e44974`):

- `src/session/inject-parser.ts` wraps `parsePtyEnvelope`, narrowing to the
  five envelope kinds the orchestrator acts on (`report`, `hold`,
  `cleanup-request`, `extend-lifetime`, `test-report`). Markdown fallback
  forms preserved for the pre-envelope tester role.
- Layer D: `bin/dispatch-cleanup-scheduler.sh` (schedule | cancel | defer |
  tick | list) with `state/dispatch/cleanup-pending.json` atomic writes.
  Schema: `{sid, report_time, scheduled_cleanup_time, source, preempt_reason?}`.
- Reconciler: `bin/session-reconciler.sh` runs every 60s under
  `~/Library/LaunchAgents/com.aigentry.reconciler.plist`. Linux systemd unit
  is the registered cross-platform follow-up.
- Workspace Host seam: `bin/lib/workspace-host.sh` with cmux + headless
  adapters (4 methods — `wh_lookup`, `wh_close`, `wh_alive`, `wh_list_ids`).
  `bin/session-cleanup.sh` routes through `close_workspace_for`.
- `bin/dispatch.sh --keep-alive` opts a session out of Layer A; the flag is
  persisted in `active.json` and honored by the scheduler + reconciler.
- R5a (#436): `bin/inject-handler.sh` writes `state/test-reports/<YYYY-MM-DD>/<sid>.json`
  on TestReport receipt (atomic tmp+mv). `docs/templates/dispatch-ref-template.md`
  carries the canonical tester REPORT format for both transports.
- Tests: 4-variant `T17_lifecycle_3layer.sh` (Layer A, Layer D, EXTEND_LIFETIME,
  reconciler crash sweep) + `T18_test_report_handoff.sh` (both transports +
  negative) + `T19`–`T24` unit-style coverage of scheduler, keep-alive
  short-circuit, reconciler GC root, workspace-host adapter, inject-handler.
  18 TS tests under `tests/session/inject-parser.test.ts`. Snyk: 0 findings
  on new TS.
