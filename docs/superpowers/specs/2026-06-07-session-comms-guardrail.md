---
status: proposed (SPEC FIRST — HOLD for APPROVED, no implementation)
date: 2026-06-07
topic: session↔session info-only comms guardrail — design spec
adr: docs/adr/2026-06-07-session-comms-guardrail.md
task: "#533 (part of #531 sequence-100% epic)"
role: architect (design only; a coder implements after APPROVED)
---

# Design Spec — Session↔Session Info-Only Comms Guardrail

> Companion to ADR 2026-06-07. The ADR decides *what/why*; this spec details the
> *mechanism* a coder will implement **after** orchestrator + user approval. **No code is
> written this turn.** All `state/` paths are the orchestrator's domain — named here, created
> by the orchestrator/coder later.

## 0. Scope recap (from the ADR)

- **Detection:** structural whitelist — non-orch↔non-orch injects must carry a sanctioned
  `ask-request`/`ask-reply` envelope; everything else on that lane is out-of-policy. No NLP.
- **Surface:** Phase 1 = `bin/ask.sh` (sanctioned sender channel) + orchestrator-side
  reconcile-tick **auditor** (warn-mode). Phase 2 = telepty daemon-side inject-validator hook
  (hard in-band block) when telepty#18 lands.
- **Cap:** 3 rounds per `pairkey__thread`; refuse + auto-escalate at cap; reset on
  close/ack/TTL.

## 1. The lane definition (what is in scope)

```
inject(from S, to T)
├── S == orchestrator  OR  T == orchestrator   → ORCH LANE   → untouched (existing inject-parser)
└── S != orchestrator AND T != orchestrator    → PEER LANE   → GUARDRAIL APPLIES
```

Only the **PEER LANE** is guarded. The orchestrator's own dispatch/REPORT/HOLD traffic is
out of scope and keeps flowing through `src/session/inject-parser.ts` unchanged. "orchestrator"
is matched by sid against the known orchestrator session id(s) (configurable; today
`orchestrator` / `aigentry-orchestrator-claude`).

## 2. Envelope schema (the whitelist token)

Reuses the existing fenced-JSON-preferred + markdown-fallback discipline of
`src/session/inject-parser.ts`. Two new kinds, **PEER-LANE only**:

### 2.1 `ask-request`

Fenced JSON (preferred):
```json
{
  "kind": "ask-request",
  "from": "<sender-sid>",
  "to": "<target-sid>",
  "thread_id": "<stable-id-for-this-info-thread>",
  "round": 1,
  "question": "<read-only info / context being requested>",
  "reply_to": "<sender-sid>"
}
```

Markdown fallback (mirrors REPORT/HOLD line style so a worker can emit it trivially):
```
ASK_REQUEST: <to-sid> | from: <sender-sid> | thread: <thread_id> | round: <n> | q: <question>
```

### 2.2 `ask-reply`
```json
{ "kind": "ask-reply", "from": "<sid>", "to": "<sid>", "thread_id": "<id>", "round": 1, "answer": "<info>" }
```
```
ASK_REPLY: <to-sid> | from: <sender-sid> | thread: <thread_id> | round: <n> | a: <answer>
```

### 2.3 Validity rules (classifier predicate)
A PEER-LANE inject is **in-policy** iff ALL hold:
1. parses as `ask-request` or `ask-reply` (fenced JSON first, else markdown fallback);
2. `from`/`to` match the actual sender/target sids of the inject;
3. `thread_id` is present and non-empty;
4. `round` is an integer `1..3`;
5. it carries **no** work-delegation shape — enforced *structurally*, not semantically:
   the schema simply has no field that means "do this work / produce this artifact"; an inject
   that asks for work won't be a well-formed `ask-*` envelope and thus fails rule 1.

Anything PEER-LANE that fails the predicate is **out-of-policy** → warn (Phase 1) /
block (Phase 2) + escalate.

> Note: `inject-parser.ts` currently recognizes `report | cleanup-request | extend-lifetime |
> hold | test-report`. This spec **adds** `ask-request | ask-reply` as additive kinds (Rule 29
> surgical — new `case`s + new validators, no edits to existing branches).

## 3. Phase 1 — sender wrapper `bin/ask.sh` (sanctioned PEER channel)

Modeled on `bin/dispatch.sh` (the Rule 32 sanctioned dispatch channel). `bin/ask.sh` is the
**only blessed** worker→worker channel; raw `telepty inject` peer→peer is out-of-policy
(caught by the auditor, §4).

```
ask.sh --from <sid> --to <sid> --thread <id> --round <n> request "<question>"
ask.sh --from <sid> --to <sid> --thread <id> --round <n> reply   "<answer>"
ask.sh --help
```

Behavior (atomic, in order):
1. **Lane check.** If `--to` is the orchestrator → refuse ("use dispatch.sh / REPORT path").
2. **Cap check (read).** Read `state/session-comms/<pairkey>__<thread>.json` (§5).
   If `rounds >= 3` and this is a new round → **refuse send**, run escalation (§6), exit non-zero.
3. **Increment (atomic).** Bump the round counter under the orchestrator index-lock convention
   (reuse `src/session/persistence/index-lock.ts` semantics; the wrapper calls a tiny node
   shim, NOT a re-implementation — Rule 4/DRY).
4. **Compose envelope** (§2) and `telepty inject --from <sid> <to> '<fenced-json>'`.
5. **Emit telemetry** (§7) `reason: peer_ask_{request,reply}_sent`.

`bin/ask.sh` carries the conflict signal too: `--conflict` on a reply forces immediate
escalation (§6) regardless of round count.

## 4. Phase 1 — orchestrator-side auditor (detection + raw-bypass catch)

Runs on the **existing reconcile tick** (alongside `bin/dispatch-tracker.sh check`; no new
daemon — §1 경량). Algorithm per tick:

1. **Pull** new PEER-LANE injects from telepty's inject log since the last cursor
   (telepty already logs injects; the auditor tails them — read-only).
2. **Classify** each via the §2.3 predicate (reuse the extended `inject-parser`).
3. For **in-policy** injects emitted outside `bin/ask.sh` (worker called raw `telepty inject`
   but happened to use the envelope): reconcile the round counter (so the cap still holds) and
   emit `peer_ask_reconciled`.
4. For **out-of-policy** PEER-LANE injects (no envelope / malformed / work-delegation shape):
   - Phase 1 (`warn`): emit `peer_inject_out_of_policy` + push a **HOLD** to the orchestrator
     inbox naming `{from,to,excerpt}` so the orchestrator (HITL) can correct the worker.
   - Phase 2 (`hard-fail`, telepty hook): the daemon rejected it in-band already; the auditor
     only records the rejection telemetry.
5. **TTL sweep** (§5 reset c): expire stale `state/session-comms/*` threads.

The auditor **never blocks** in Phase 1 (it can't — the inject already happened); it
**detects, counts, and escalates**. This is the documented Class-B-style trust boundary.

## 5. Round-counter state (`state/session-comms/`)

One file per pair-thread. `pairkey` = the two sids **sorted** then joined with `__` (so A↔B and
B↔A share one counter). Filename: `<pairkey>__<thread_id>.json`.

```json
{
  "pairkey": "architect-533__coder-512",
  "thread_id": "ctx-gate-api",
  "rounds": 2,
  "parties": ["architect-533", "coder-512"],
  "last_round_at": "2026-06-07T12:00:00Z",
  "last_kind": "ask-reply",
  "status": "open",
  "escalated": false
}
```

- **Increment:** wrapper (Phase 1) / daemon (Phase 2), atomic under index-lock; auditor
  reconciles raw-bypass rounds.
- **Cap:** `rounds > 3` is the trip (the 4th round is refused).
- **Reset / close** — `status: open → closed` and counter cleared on:
  - (a) explicit `thread close` (either party emits `ASK_CLOSE: <to> | thread: <id>`),
  - (b) orchestrator **ack** of an escalation,
  - (c) **TTL** sweep on the reconcile tick (default 30 min idle, matching the dispatch
    healthcheck cadence; tunable via env).

`state/session-comms/` is the **orchestrator's** path — created by the orchestrator/coder at
implementation time, not by this architect turn.

## 6. Escalation at cap / conflict

On the would-be 4th round, or any `--conflict`:

```
trip
├── conflict OR ≥3 parties needed → deliberation MCP (≥3)
│     reuse src/gate/class-c + AGENTS.md ≥3-parallel rule;
│     open deliberation session with {parties, thread context}; set escalated=true
└── otherwise → orchestrator HOLD inbox
      inject HOLD envelope (parsed by inject-parser) →
      orchestrator decides next steps with the user (HITL) → may ack/reset (§5b)
```

The escalation **replaces** the blocked 4th inject — the channel does not silently drop; it
routes upward, satisfying the policy's "escalate to deliberation MCP (≥3) or the orchestrator".

## 7. Telemetry (reuse `src/telemetry/spawn-events.ts` conventions)

Reuse the existing event/`reason` string discipline (as Class C did — no schema break). New
`reason` values (PEER-LANE, suffixed with the pairkey/thread for traceability):
`peer_ask_request_sent`, `peer_ask_reply_sent`, `peer_ask_reconciled`,
`peer_inject_out_of_policy`, `peer_cap_tripped`, `peer_escalated_{deliberation,orchestrator}`,
`peer_thread_{closed,ttl_expired}`. No new event_kind; reuse `spawn_accepted`/`spawn_rejected`
or a sibling `peer_*` event per the implementer's read of the schema guard (#118).

## 8. Live test plan (3 scenarios — the testability deliverable)

Two real worker sessions spawned via `bin/dispatch.sh` (e.g. `coder-A`, `coder-B`); orchestrator
present. Each scenario asserts on **state file + telemetry + observed delivery**.

### Scenario 1 — info-request (ALLOWED, happy path)
1. `coder-A` runs `bin/ask.sh --from coder-A --to coder-B --thread t1 --round 1 request "what's the gate API signature?"`.
2. `coder-B` replies via `bin/ask.sh ... --round 1 reply "<answer>"`.
- **Assert:** B receives the question; `state/session-comms/<A__B>__t1.json` `rounds=1`,
  `status=open`; telemetry `peer_ask_request_sent` + `peer_ask_reply_sent`; **no** escalation,
  **no** `out_of_policy`.

### Scenario 2 — work-delegation attempt (BLOCKED + routed)
1. `coder-A` tries to delegate work to `coder-B` two ways:
   (a) raw `telepty inject --from coder-A coder-B "go implement X in file Y and push"` (no envelope);
   (b) a malformed `ask-request` whose body is a work order.
- **Assert (Phase 1 warn):** auditor emits `peer_inject_out_of_policy` for both; a HOLD lands in
  the orchestrator inbox naming `{from:coder-A, to:coder-B, excerpt}`; orchestrator (HITL) is the
  one that may then route real work (requesting-session → orchestrator → user → orchestrator
  delegates). `coder-A` did **not** cause `coder-B` to start work via the peer lane.
- **Assert (Phase 2, when available):** the daemon rejects (a)/(b) in-band; B never receives them.

### Scenario 3 — 3-round cap trip (ESCALATES)
1. A↔B exchange rounds 1, 2, 3 on `thread t2` via `bin/ask.sh` (each allowed).
2. A attempts round 4: `bin/ask.sh ... --thread t2 --round 4 request "..."`.
- **Assert:** the 4th send is **refused** (`ask.sh` exits non-zero, `peer_cap_tripped`); the
  counter shows `rounds=3` not 4; an escalation fires — `peer_escalated_orchestrator` (HOLD to
  orchestrator) or, if `--conflict`/≥3 parties, `peer_escalated_deliberation` (a deliberation
  session opens with both parties). After orchestrator ack, `state` resets (`status=closed`),
  and a fresh `thread t3` is allowed again.

**Pass criteria:** S1 fully allowed & counted; S2 both attempts flagged/blocked & routed via
orchestrator (never peer-executed); S3 4th round refused & escalated & resettable. All three
assert on the state file + telemetry, not just observed UI.

## 9. Implementation checklist (for the post-APPROVED coder — NOT this turn)

- [ ] `src/session/inject-parser.ts` — add `ask-request | ask-reply` kinds (additive `case`s +
      validators + markdown fallbacks). Rule 29 surgical.
- [ ] `bin/ask.sh` — sanctioned PEER channel (§3); calls a tiny node shim for atomic counter
      I/O (reuse `persistence/index-lock` + `atomic-write`; no re-implementation — Rule 4/DRY).
- [ ] orchestrator-side auditor module + wire into the reconcile tick (§4); warn-mode default.
- [ ] `state/session-comms/` provisioning + TTL sweep (§5) — orchestrator domain.
- [ ] escalation glue to deliberation MCP / orchestrator HOLD (§6) — reuse class-c + inject-parser.
- [ ] telemetry `reason` strings (§7) — reuse spawn-events schema.
- [ ] AGENTS.md pointer to this guardrail (one line under the existing §2-3 / "세션 간 통신" rule).
- [ ] live test harness for the 3 scenarios (§8).
- [ ] **Snyk** `snyk_code_scan` on new first-party code (ask.sh shim + auditor) before DONE.
- [ ] Phase 2 follow-up (separate task): telepty daemon inject-validator hook (telepty#18).

## 10. Constitutional + boundary notes
- §1 경량 — no new subsystem; rides existing reconcile tick + telemetry + envelope parser.
- §2 크로스 — shell + JSON envelope; CLI/OS-agnostic; degrades to warn+audit everywhere.
- §3 역할 — policy = aigentry (declares envelope/cap/escalation); transport = telepty (Phase 2
  enforces). §17 — stock-telepty fallback (Phase 1) is the always-available path.
- Rule 29 — new files + additive parser cases + one AGENTS.md line; no reformat of existing code.

---
**STATUS: HOLD for `APPROVED`.** Architect = design only. No implementation, no commit, no push
(orchestrator lands). On APPROVED, a coder executes §9.
