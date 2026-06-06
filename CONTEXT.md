# Aigentry Orchestrator

Orchestrator coordinates multi-CLI worker sessions across machines, dispatches work, validates reports, and supervises session lifecycle. Coded for cross-platform parity (§2) and component independence (§9).

## Language

**Session**:
A telepty-registered execution context wrapping a CLI (claude/codex/gemini/...) with a stable `sid`. Lives for one task lifecycle (spawn → REPORT → cleanup).
_Avoid_: process, terminal, tab.

**Workspace Host**:
The terminal/UI surface that displays a session (cmux workspace, zellij pane, headless none, windows-terminal tab, ghostty tab). Optional — a session may run headless.
_Avoid_: terminal, frontend, UI layer.

**surface_orphaned**:
A structured bus event emitted by **telepty** when a session's Workspace Host surface is detected gone (or its zombie *session* is reclaimed). Payload: `{ sid, backend, cmuxWorkspaceId, surfaceGoneSeconds, livenessVerdict }`. It is a **signal**, not an actuation: telepty *probes* surface liveness (read-only `isSurfaceAlive`) and *signals*; the **orchestrator** *actuates* surface close (`workspace-host.sh` `wh_close`) on receipt. This is the telepty-probes / orchestrator-actuates split ratified by the 2026-05-30 surface-ownership verdict.
_Avoid_: surface-close event, kill signal (it does not close anything).

**Dispatch**:
The act of injecting a task spec to a session via `bin/dispatch.sh`. Recorded in `state/dispatch/active.json` until REPORT received.
_Avoid_: assignment, task, job.

**Dispatch Registry**:
`state/dispatch/active.json` — single source of truth for "currently active sessions awaiting REPORT". Also serves as **GC root** for the Reconciler (mark-and-sweep semantics).
_Avoid_: queue, log, journal.

**REPORT**:
An inject sent from a worker session to orchestrator announcing task completion. Format: `REPORT: <task-tag>-DONE | <key>: <value> ...`. Triggers validation + (Layer A path) the 30s pre-CLEANUP_REQUEST grace.
_Avoid_: result, finish, ack.

**CLEANUP_REQUEST**:
An inject sent from a worker session to orchestrator declaring "my session can be cleaned up now". Sent ~30s after REPORT if no follow-up inject arrived. Triggers `bin/session-cleanup.sh <sid>`.
_Avoid_: shutdown, terminate, kill.

**Reconciler**:
A periodic (60s) level-triggered sweep that catches sessions Layer A+D missed (REPORT never sent, orchestrator-side bug, partial cleanup). Computes orphan set = all-known-sessions − dispatch_registry-active − PROTECTED. Idempotent, backs off on cleanup failure.
_Avoid_: GC, sweeper, watchdog.

**HOLD inject**:
A boundary-stop inject sent from worker to orchestrator at every phase boundary in a dispatch ref. Format: `HOLD: <task-tag> | phase: N/M awaiting | reason: ... | needs: ...`. Silent waiting (markdown HOLD in reply only) is forbidden — must be real `telepty inject`.
_Avoid_: pause, wait, idle.

**Dispatch ref**:
A self-contained spec file (`state/dispatch/YYYY-MM-DD-<topic>.md`) used as `--ref` payload for `telepty inject`. `dispatch_kind: fresh-session` requires inline excerpts of all cited Rules/§/envelopes (receiver has no prior context).
_Avoid_: spec, prompt, brief.

**Session Reconcile Loop**:
The single level-triggered control loop (driven by the existing 60s launchd Reconciler) that owns all workflow automation: per Session in the Dispatch Registry it runs **observe → decide → act** (`SessionProbe` → `Policy` → `Action`). Generalizes the ADR 2026-05-20 Reconciler from cleanup-only to the whole lifecycle. ADR 2026-06-06.
_Avoid_: scheduler, watchdog, controller.

**SessionProbe**:
The single authority that observes a Session's current state — `observe(sid) → SessionState`. Reads telepty screen + session-info and classifies. Replaces the three drifting classifiers (`dispatch.sh:is_ready`, `dispatch-verify`, `dispatch-tracker:classify_screen`). All banner/error/spinner/modal regex lives here and nowhere else. ADR 2026-06-06.
_Avoid_: classifier, detector, parser.

**SessionState**:
The structured value SessionProbe returns: `{ alive, ready, surface, activity, cli, detail }`. `surface ∈ {working, idle, unsubmitted, welcome, modal, error, crash, thinking_block, sandbox_prompt, raw_shell}`; `activity ∈ {moving, static}`. The unit-test surface for Policy.
_Avoid_: status, screen, health.

**Policy**:
A **pure function** `decide(status, SessionState) → Action` — the orchestrator's autonomous decision-making in one place, a table, testable on SessionState fixtures with no I/O. ADR 2026-06-06.
_Avoid_: rules, handler, logic.

**Action**:
What Policy decides the Session Reconcile Loop should do: `{ NOOP, RESUBMIT_ENTER, SEND_KEY, RESPAWN, REDISPATCH, CLEANUP, ESCALATE }` (v1). Applied via existing primitives (`dispatch.sh`, `telepty send-key`, `session-cleanup.sh`).
_Avoid_: command, op, task.

**Escalate**:
The single Action that surfaces to the interactive orchestrator (genuine business/architecture decision) via `verify-escalations.jsonl` — now the *exception* channel, not the default. Every other Action resolves autonomously. ESCALATE is also the ambiguity default (when SessionState is unknown, never act destructively).
_Avoid_: alert, notify.

## Relationships

- A **Session** is registered in **telepty** (mandatory) and may have a **Workspace Host** (optional).
- A **Dispatch** records `(sid, ref-path, dispatch-time)` in the **Dispatch Registry**.
- A **REPORT** triggers `Layer A` self-cleanup flow OR `Layer D` orchestrator-timeout fallback.
- A **CLEANUP_REQUEST** runs `session-cleanup.sh`, which calls the appropriate **Workspace Host** adapter and removes the entry from telepty + Dispatch Registry.
- The **Reconciler** uses **Dispatch Registry** as GC root — sessions absent from it (and from PROTECTED) are sweep candidates.

## Example dialogue

> **Engineer:** "Why doesn't the orchestrator just detect when a session is dead and clean it up?"
> **Architect:** "Because that's an inference. Owner-initiated cleanup is the production pattern — the **Session** sends a **REPORT** and then a **CLEANUP_REQUEST**. The orchestrator only executes."
> **Engineer:** "What if the session crashes before sending CLEANUP_REQUEST?"
> **Architect:** "Layer D — orchestrator schedules cleanup 60s after the REPORT if no CLEANUP_REQUEST arrives. If REPORT never arrived either, the **Reconciler** catches it on its next sweep against the **Dispatch Registry**."

## Flagged ambiguities

- "Session" was previously conflated with "cmux workspace" in some bash scripts (`session-cleanup.sh:107` extracted `.cmuxWorkspaceId` from telepty session) — resolved: a **Session** is the telepty-registered context, a **Workspace Host** is a separate concern accessed via adapter.
- "Cleanup" was overloaded: meant "kill PID" in some places, "close cmux workspace" in others, "DELETE registry entry" in others — resolved: the 3-step `cleanup_one()` in `session-cleanup.sh` is the canonical sequence, all three steps required.

## Decision review log

Context-Language Decision Review (CLDR) entries — appended when an adjudication or external perspective reveals a resolved domain decision was re-introduced or contradicted downstream (AGENTS.md workflow §6). Schema: `{date, trigger, finding, context_correction, downstream_action}`.

```yaml
decision_review_log:
  - date: 2026-05-30
    trigger: "tri-perspective boundary audit"
    finding: "#30 closeSurface re-coupled Session→Workspace-Host actuation in telepty, duplicating the mature workspace-host.sh adapter and contradicting BOUNDARY.md dumb-pipe charter"
    context_correction: "surface close/focus = orchestrator adapter; telepty = probe+signal+session-GC only"
    downstream_action: "stage telepty diff selectively; add warp adapter; addenda to 2 ADRs + BOUNDARY.md"
```

> CLDR trigger (c) — external-perspective adjudication: the 2026-05-30 tri-perspective surface-ownership verdict revealed #30 re-introduced the conflation marked **resolved** at "Flagged ambiguities" above (a **Session** is the telepty-registered context; a **Workspace Host** is a separate concern accessed via adapter). Source: [`docs/adr/2026-05-30-surface-ownership-boundary-verdict.md`](docs/adr/2026-05-30-surface-ownership-boundary-verdict.md).
