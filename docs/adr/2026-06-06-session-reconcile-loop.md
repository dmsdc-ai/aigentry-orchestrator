---
status: accepted
date: 2026-06-06
supersedes_partial: dispatch-verify.sh / dispatch-autoverify.sh / dispatch-tracker.sh(check) / dispatch-cleanup-scheduler.sh(tick) / session-reconciler.sh(sweep) — these collapse into the loop
---

# Session Reconcile Loop — one level-triggered loop owns all workflow automation

## Context

"All workflow automation is the orchestrator's role" (2026-06-06 user directive). A structural audit (two Explore sweeps) found the automation is **asymmetric**:

- **Autonomous**: the TRIGGER + DETECT + CLEANUP side — launchd (`com.aigentry.reconciler.plist`, 60s), `dispatch.sh` inline verify, the 3-layer cleanup (ADR 2026-05-20).
- **Human-in-the-loop**: the **RESOLVE / DECIDE** side. Every escalation lands in an append-only log (`verify-escalations.jsonl`, `holds.log`, `alerts.log`) whose **only reader is the interactive orchestrator**. Scripts *detect + log*; resolving (answer modal, respawn on thinking-block, re-dispatch on death, resubmit a dropped CR) is done by hand, every time.

Secondary friction: **screen classification is duplicated 3×** with drifting regex — `dispatch.sh:is_ready`, `dispatch-verify.sh` (ALIVE/CLEAN/MOVING), `dispatch-tracker.sh:classify_screen`. This drift caused real incidents this session (an improvement added to verify did not reach tracker; codex init-spinner false-positives).

The reactive history (auto-verify, `--resubmit`, unsubmitted-detector, surface-rebind were each bolted on per-gap) is the symptom: there is **no single deep module that owns "drive the session lifecycle"** — automation is smeared across 5 scripts + 3 launchd jobs + hooks.

## Decision

One **level-triggered control loop** (the K8s-controller pattern ADR 2026-05-20 already cites — generalized from cleanup-only to the whole lifecycle), driven by the **existing** 60s launchd Reconciler (no new daemon). Per tick, per Session in the Dispatch Registry: **observe → decide → act**.

```
reconcile_tick():                              # launchd 60s — unchanged trigger
  for entry in DispatchRegistry.active():        # SSOT, one read
    state  = SessionProbe.observe(sid)           # observe  (seam 1)
    action = Policy.decide(entry.status, state)  # decide   (seam 2, pure)
    Action.apply(sid, action)                    # act
    DispatchRegistry.update(sid, action.status)  # record transition
```

**Exactly two seams** (the only abstractions):

1. **SessionProbe** — `observe(sid) → SessionState`. The single authority on session state. Absorbs all three classifiers.
   `SessionState = { alive, ready, surface ∈ {working, idle, unsubmitted, welcome, modal, error, crash, thinking_block, sandbox_prompt, raw_shell}, activity ∈ {moving, static}, cli, detail }`
2. **Policy** — `decide(status, SessionState) → Action`. A **pure function** (table) — the orchestrator's autonomous decision-making, in one place, unit-testable on `SessionState` fixtures.
   `Action ∈ { NOOP, RESUBMIT_ENTER, SEND_KEY(key), RESPAWN, REDISPATCH, CLEANUP, ESCALATE(reason) }` (v1).

`DispatchRegistry` stays a **thin** accessor over `active.json` (`active()` / `update()` with the existing lock) — not a heavyweight module.

**`ESCALATE` is the single human surface.** Every other Action resolves autonomously. That is the structural completion of "automation = orchestrator's role": operations run in the loop; only genuine business/architecture decisions reach the interactive orchestrator (still via `verify-escalations.jsonl`, now the *exception* path, not the default).

## What collapses (this is a simplification, not an addition)

| Today (scattered) | Becomes |
|---|---|
| `dispatch-verify.sh` (3-probe classify) | `SessionProbe` + Policy `verify` rows |
| `dispatch-autoverify.sh` | one pass of the loop (deleted as a separate script) |
| `dispatch-tracker.sh check` (classify_screen) | `SessionProbe` + Policy `stuck/redispatch` rows |
| `dispatch-cleanup-scheduler.sh tick` + `session-reconciler.sh` sweep | Policy `cleanup` row (INV-17 gate preserved) |
| 3 copies of banner/error/spinner regex | 1 (inside `SessionProbe`) |

Net **fewer scripts, one regex corpus**. Deletion test: delete the loop and the classify/resolve complexity scatters back across 5 callers — it concentrates complexity, so it earns its keep.

## Code shape (simple, no spaghetti — binding constraints)

- `bin/session-probe.py` — observe. One file. Input `sid` (+ optional pre-captured screen/info for testability), output `SessionState` JSON. All regex here, nowhere else.
- `bin/policy.py` — decide. One file. Pure: `(status, state_json) → action_json`. No I/O, no telepty calls — trivially unit-testable.
- `bin/session-reconciler.sh` — the loop glue only: read registry, call probe, call policy, dispatch the Action to existing primitives (`dispatch.sh`, `telepty send-key`, `session-cleanup.sh`, respawn). Thin.
- Each file small + single-purpose; the loop never inlines classification or decision logic (those live behind the two seams).

## Safety nets (no implementation without all three)

1. **ESCALATE-default bias** — when `SessionState` is ambiguous/`unknown`, Policy returns `ESCALATE`, never a destructive act.
2. **INV-17 preserved** — `CLEANUP` keeps the existing multi-signal gate (surface-gone alone never kills; PID/disconnect corroboration required). Policy encodes it; the loop does not bypass it.
3. **Shadow-run migration** — `SessionProbe`+`Policy` run in `--shadow` first: log what they *would* decide alongside the old scripts, assert parity on a fixture corpus of real captured screens (codex init-spinner, unsubmitted context-ref, thinking-block-400, trust modal, raw shell, working spinner) before any old script is deleted.

## Consequences

- New domain terms (added to `CONTEXT.md`): **SessionProbe**, **SessionState**, **Policy**, **Action**, **Escalate**.
- `verify-escalations.jsonl` becomes the *exception* channel (genuine decisions), not the default catch-all.
- Existing 3-layer cleanup (ADR 2026-05-20) is **not re-litigated** — its Reconciler IS this loop; Layer A/D owner-initiated paths remain (they feed Registry status the Policy reads).
- Migration is staged (shadow → swap → delete), so a Policy bug can't silently break live cleanup.

## Rejected

- **Four separate modules** (Escalation Resolver + Session Probe + Reconciler-consolidation + Registry): violates §1 (경량). The loop subsumes all four; separate modules duplicate the observe/registry access N times.
- **A new always-on daemon**: unnecessary — the 60s launchd Reconciler already exists and is the natural driver.
- **Keep the per-gap reactive style**: it produced the current smear; structurally unbounded.
