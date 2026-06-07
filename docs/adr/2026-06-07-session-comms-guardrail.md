---
status: proposed
date: 2026-06-07
topic: session↔session information-only comms guardrail
task: "#533 (part of the #531 sequence-100% epic)"
supersedes_policy_source: docs/adr/2026-06-06-orchestration-sequence.md (§2-3 invariant + 3-round guardrail)
---

# ADR 2026-06-07 — Session↔Session Information-Only Comms Guardrail

## Context

ADR 2026-06-06 (canonical orchestration sequence, §2-3) **amended the policy** for
direct session-to-session telepty communication:

- ✅ **Allowed:** a worker session directly `telepty inject`s another worker session
  **for information/context only** (read-only exchange).
- ❌ **Forbidden:** a session delegating *implementation/work* to another session.
  Work routes: requesting-session → orchestrator → **user confirmation (HITL)** →
  orchestrator delegates to the right session. A session never delegates to a session
  (preserves the spawn-capability gate — ADR-MF #8, `src/session/permission-manager.ts`).
- 🛑 Direct info exchange is capped at **3 rounds**; exceeding the cap **or** a conflict →
  escalate to the deliberation MCP (≥3 parties) or the orchestrator.

That policy is **written but UNEXERCISED**: no implementation or guardrail enforces it,
and it has never been tested live. The blunt prior rule ("세션 간 직접 inject 금지,
deliberation 경유 필수") was self-enforcing by total ban; the relaxed rule opens a channel
that nothing currently bounds. This ADR decides **how** the relaxed channel is guarded —
the lightest mechanism that (a) keeps the allowed read-only channel easy, (b) stops
work-delegation leaking spawn authority below the orchestrator, and (c) bounds the 3-round
cap with a defined escalation.

### The physical-interception constraint (drives everything below)

A worker→worker inject (`telepty inject --from A B "..."`) is routed by the **telepty
daemon**. It does **not** pass through the orchestrator host process, and it does **not**
pass through `src/gate/` (which gates *the orchestrator host's own outbound spawns* —
Class A telepty/cmux/cli_direct, Class B Agent-tool, Class C MCP). Therefore:

- The **only in-band chokepoint** that sees every worker→worker inject is the telepty
  daemon itself.
- The orchestrator can only observe worker→worker injects **out-of-band**, after the fact,
  via telepty's inject log / telemetry.
- Any "validator" placed in `src/gate/` or an orchestrator-side wrapper physically never
  runs on a worker→worker inject **unless the sender invokes it** — i.e., it degrades to a
  *sender-side wrapper* with a *sender-honesty* trust model.

This is the same trust boundary already accepted for **Class B** ("Class B integrity rests
on parent honesty… a malicious or buggy parent that calls `Agent` directly bypasses the
validator"; `docs/gate-architecture.md` §3) and for the **Rule 32 dispatch-helper**
convention (raw `telepty inject` is permitted for narrow cases; the sanctioned path is
`bin/dispatch.sh`). The guardrail's realistic goal is therefore: **prevent accidental
work-delegation, make the allowed info-request path the path of least resistance, and
detect/audit violations** — not to be robust against an adversarial worker calling raw
`telepty inject` (only the daemon, Phase 2, can do that).

## Decision questions

### Q1 — Detection: info-REQUEST vs work-DELEGATION

Three candidate mechanisms (dispatch §27.1):

| # | Mechanism | False-positive cost | §1 경량 | Verdict |
|---|-----------|---------------------|---------|---------|
| 1 | NLP/keyword heuristic on inject content ("classify the prose") | **High** — "can you check X and fix it" is ambiguous; misclassifies both ways | Heavy (a classifier subsystem) | ❌ reject |
| 2 | Required envelope/prefix (`ask-request` / `[INFO-REQ]`) — allow only well-formed info envelopes; deny other non-orch↔non-orch injects | **Low** — structural, not semantic | Light (one envelope + one check) | ✅ core |
| 3 | Sanctioned wrapper command (`telepty ask` / `bin/ask.sh`) that emits the envelope + tracks rounds | Low | Light (thin shell wrapper) | ✅ delivery vehicle for #2 |

**Decision: invert the problem.** Do **not** try to *detect delegation* (semantically hard,
high false-positive). Instead **whitelist info-requests** structurally and **deny-by-default**
everything else on the non-orchestrator↔non-orchestrator lane:

> A `telepty inject` whose **sender ≠ orchestrator AND target ≠ orchestrator** is allowed
> **only** if it carries a well-formed `ask-request` / `ask-reply` envelope emitted by the
> sanctioned wrapper. Any other session→session inject is **out-of-policy** (warn → block).

This makes the *allowed* path explicit and machine-checkable, and makes *work-delegation*
fail by construction (there is no sanctioned envelope for "do this work" between two
workers — that shape simply isn't in the whitelist). Mechanism #2 is the rule; mechanism #3
is how senders comply cheaply. The orchestrator lane (any inject to/from the orchestrator)
is untouched — REPORT/HOLD/dispatch all keep flowing through the existing `inject-parser`.

### Q2 — Enforcement surface (Art.3 역할 — whose job?)

| Option | Where | Can hard-block worker→worker in-band? | telepty change? | Art.3 fit |
|--------|-------|----------------------------------------|-----------------|-----------|
| (a) telepty daemon-side inject validator | telepty repo | **Yes** (daemon is the chokepoint) | **Yes** (cross-repo) | transport enforces declared policy |
| (b) `src/gate/` layer (enforceSpawn reuse) | orchestrator | **No** — gate never runs on worker→worker injects; an inject is not a `SpawnRequest` | No | category error (wrong abstraction) |
| (c) orchestrator-side wrapper | orchestrator | **No** — orchestrator doesn't sit on the worker→worker path | No | policy owner, but blind to the lane |

**Option (b) is not a distinct surface.** The gate gates *spawns from the orchestrator host*.
A worker→worker info inject is neither a spawn nor on the orchestrator host's path. Forcing
an inject through `enforceSpawn(SpawnRequest)` would be a §1 경량 violation by **wrong
abstraction** (an inject has no role/cwd/task/capability-subset semantics to validate). We
**reuse the gate's telemetry shape and `{ok,code,detail}` result conventions** for
consistency, but the *surface* is not `enforceSpawn`.

**Decision: a phased hybrid, Phase 1 first (mirrors Class C Phase 1→2 and the gate
warn→hard-fail staging).**

- **Phase 1 (ship now — the lightest thing that works, no telepty change):**
  *Sender-side sanctioned wrapper* `bin/ask.sh` (the only blessed worker→worker channel,
  exactly as `bin/dispatch.sh` is the blessed dispatch channel under Rule 32) **+
  orchestrator-side telemetry classifier/auditor** that tails telepty's inject log on the
  reconcile tick, classifies each non-orch↔non-orch inject (sanctioned-envelope vs
  out-of-policy), and flags/escalates violations. Default **warn-mode** during the compat
  window (consistent with `AIGENTRY_SPAWN_VALIDATION_MODE` warn default).
- **Phase 2 (promote to hard in-band block when telepty#18 daemon handshake lands):**
  move the same classifier into a **telepty daemon-side inject-validator hook**. Out-of-policy
  worker→worker injects are rejected in-band before delivery. Policy (envelope schema, cap
  number, escalation target) is still **declared by aigentry** and merely *enforced* by the
  transport — Art.3 clean.

**Why Phase 1 = sender-wrapper + orchestrator-audit (not "just put it in telepty now"):**
- **Art.17 무의존:** Phase 1 works with **stock telepty** — public users get the guardrail
  by installing aigentry alone. Telepty hard-block is an *enhancement*; Phase 1 is the
  always-available **fallback path** Art.17 mandates.
- **Art.1 경량:** a ~60-line shell wrapper + a classifier that reuses the existing reconcile
  tick + existing telemetry is far lighter than a new daemon subsystem, and ships immediately.
- **Art.3 역할:** comms **policy** is the orchestrator-ecosystem's job (it owns the rule book);
  **transport** is telepty's. Phase 1 keeps policy fully in aigentry. Phase 2 lets telepty
  *enforce* what aigentry *declares* — the policy never moves into telepty.
- **Trust model honesty:** Phase 1 cannot stop a worker that calls raw `telepty inject` — it
  catches that out-of-band and flags it. This is the **same** parent-honesty model already
  accepted for Class B and Rule 32. We do not pretend Phase 1 is a hard gate; we document it
  as warn+audit and reserve hard-block for Phase 2 (the daemon).

### Q3 — 3-round cap: tracking, reset, cap-action

- **Unit.** A *round* = one `ask-request` + its `ask-reply` between an **ordered-insensitive
  pair**, scoped to a **thread** (`thread_id`). Cap = **3 rounds per thread** (matches the
  policy text). Thread-scoping prevents two unrelated info-requests between the same pair
  from sharing a counter (false escalation).
- **Where tracked.** Orchestrator-side state `state/session-comms/<pairkey>__<thread>.json`
  (`pairkey` = the two sids sorted + joined, so A→B and B→A share it). `state/` is the
  orchestrator's domain (this ADR only *designs* the path; the orchestrator/coder creates it).
  In Phase 1 the **wrapper** increments the counter atomically before send; the **reconcile
  auditor** reconciles it from the telepty log (so a raw-inject bypass is still counted).
  In Phase 2 the daemon increments authoritatively.
- **Cap-action.** On the would-be **4th** round (or on a detected conflict at any round):
  the wrapper **refuses to send** and instead **auto-escalates**:
  - *conflict OR ≥3 parties needed* → open a **deliberation MCP** session (≥3 parties), per
    the existing AGENTS.md ≥3-parallel-deliberation rule and `src/gate/class-c`.
  - *otherwise* → inject a **HOLD/escalation** envelope to the **orchestrator** inbox
    (parsed by the existing `inject-parser`), which decides next steps with the user (HITL).
- **Reset.** Counter clears on (a) explicit `thread close` from either party, (b) orchestrator
  ack of an escalation, or (c) a TTL sweep on the reconcile tick (stale threads). All three
  are orchestrator-side; the design names them, the orchestrator implements them.

## Decision (summary)

1. **Detection = structural whitelist, not semantic detection.** Non-orch↔non-orch injects
   must carry a sanctioned `ask-request`/`ask-reply` envelope; everything else on that lane
   is out-of-policy. No NLP.
2. **Enforcement surface = phased.** Phase 1: sender-side `bin/ask.sh` wrapper +
   orchestrator-side reconcile-tick auditor (warn-mode, stock telepty, Art.17 fallback).
   Phase 2: promote the same classifier into a telepty daemon-side inject-validator hook for
   in-band hard-block, when telepty#18 lands. Reuse gate telemetry/result conventions; do
   **not** reuse `enforceSpawn` (inject ≠ spawn).
3. **3-round cap** tracked per `pairkey__thread` in `state/session-comms/`, incremented by
   the wrapper (Phase 1) / daemon (Phase 2) and reconciled by the auditor; cap-action =
   refuse + auto-escalate (deliberation if conflict/≥3, else orchestrator HOLD); reset on
   close / ack / TTL.

The detailed mechanism (envelope schema, wrapper contract, auditor algorithm, state shape,
live test plan) is in the companion spec
`docs/superpowers/specs/2026-06-07-session-comms-guardrail.md`.

## Options considered & rejected

- **NLP/keyword delegation classifier** — rejected (Q1): high false-positive, heavy (§1).
- **Total ban (revert to pre-2026-06-06)** — rejected: contradicts the approved policy and
  the user's requested read-only channel.
- **`src/gate/` enforceSpawn reuse as the surface** — rejected (Q2): inject ≠ `SpawnRequest`;
  the gate never runs on the worker→worker lane; wrong abstraction (§1). Conventions reused,
  surface not.
- **Telepty daemon hard-block as Phase 1 (immediate)** — deferred to Phase 2: requires a
  cross-repo telepty change (telepty#18-adjacent), so it cannot ship as the *fallback* path
  Art.17 requires; we ship the stock-telepty soft path first.
- **Pure convention (a Rule in AGENTS.md, zero code)** — the genuinely lightest option,
  explicitly considered. Rejected as *insufficient*: a doc-Rule cannot **track rounds**,
  **auto-escalate at the cap**, or **audit raw-inject bypass**. The thin wrapper + reconcile
  auditor is the minimum that delivers those three; nothing smaller does.

## 위헌 심사 (Constitutional review)

| Article | Question | Verdict |
|---------|----------|---------|
| **AI 격차 (the gap)** | Does the guardrail serve closing the AI capability gap? | **Pass.** It protects the spawn-capability containment invariant (ADR-MF #8): without it, a session could launder work-delegation through an "info" inject, effectively commanding another session and bypassing the orchestrator's HITL/spawn gate — re-introducing the ungated delegation ADR-MF #8 forbids. The guardrail keeps delegation authority above the worker tier. |
| **§1 경량** | Is it the lightest thing that works? | **Pass.** Phase 1 = one ~60-line shell wrapper + a classifier riding the *existing* reconcile tick and *existing* telemetry; no new subsystem, no NLP. The lighter "pure convention" option was considered and rejected only because it cannot track/escalate/audit (see above). We reuse gate telemetry + `inject-parser` envelope discipline rather than building parallel machinery (DRY). |
| **§2 크로스환경** | Cross-CLI / cross-OS? | **Pass.** telepty is the CLI-agnostic transport (claude/codex/gemini all use it); the wrapper is POSIX shell + a JSON envelope; nothing CLI-specific. Non-cmux/non-mac hosts degrade with the same warn+audit path. |
| **§3 역할** | Whose component? | **Pass.** Comms **policy** = orchestrator-ecosystem (it declares the envelope schema, cap, escalation). **Transport** = telepty. Phase 1 keeps policy in aigentry; Phase 2 has telepty *enforce* (not own) the aigentry-declared policy. No role bleed. |
| **§17 무의존** | Runs without external deps + fallback path? | **Pass.** Phase 1 needs **no telepty change** → stock telepty + aigentry alone gives the guardrail. The telepty daemon hook (Phase 2) is an enhancement; Phase 1 is the mandated fallback. No new runtime libraries (node stdlib + shell). |
| **Rule 29 외과적** | Surgical? | **Pass (by design).** New files only (`bin/ask.sh`, the auditor module, `state/session-comms/`) + one AGENTS.md pointer; the existing `inject-parser`/gate/reconcile are *extended additively*, not reformatted. (Implementation is a later coder task — this ADR only scopes it.) |

**Verdict: PASS.** No constitutional conflict; no orchestrator waiver required.

## Consequences

**Positive.** The approved read-only channel becomes enforceable without weakening
spawn-capability gating; the allowed path is the easy path (`bin/ask.sh`); work-delegation
fails by construction (no sanctioned envelope for it); the 3-round cap has a defined tracker
and escalation; ships on stock telepty (Art.17) with a clean Phase-2 promotion to hard
in-band block that mirrors the existing Class C staging.

**Negative / accepted.** Phase 1 is **warn + audit**, not a hard in-band block — a worker
that calls raw `telepty inject` can still bypass it and is caught only out-of-band
(same trust model as Class B parent-honesty / Rule 32). Hard-block waits on telepty#18
(Phase 2). The round-counter reconciliation depends on the reconcile tick running.

**Open decision for orchestrator/user at APPROVED time** (surfaced, not unilaterally chosen):
whether to **(i)** ship Phase 1 soft-now and schedule Phase 2 (recommended — Art.17 fallback,
fastest safe value), or **(ii)** block on telepty#18 and ship hard-block directly (stronger,
but no guardrail until the cross-repo change lands). This ADR **recommends (i)**.

## Tracked dependencies (not in this ADR's scope)

| Dep | Affects | Status |
|-----|---------|--------|
| telepty#18 daemon handshake / inject hook | Phase 2 hard in-band block | upstream telepty repo |
| reconcile tick (`bin/dispatch-tracker.sh` / #517 pull path) | Phase 1 auditor cadence | in-flight |
| `state/session-comms/` provisioning | round-counter persistence | orchestrator-side (coder task) |
