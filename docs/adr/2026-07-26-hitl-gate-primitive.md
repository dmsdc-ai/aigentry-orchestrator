---
status: proposed
date: 2026-07-26
track: a740h
task: #740
supersedes_partial: none — extends ADR 2026-06-06-session-reconcile-loop (`ESCALATE` = "the single human surface") with the missing blocking/notify/resume half
amended: 2026-08-16 (#925) — implementation language freed; see "Amendment (2026-08-16, #925)"
---

# HITL Gate — one common human-in-the-loop primitive for the reconciler loop and worker loops

## Context

User directive (2026-07-26): *"loop 하네스 에이전트리 오케스트레이터가 human in the loop으로
처리가 필요해."* Plan-mode disambiguation resolved it to **both** loops, served by **one**
primitive. The five policy decisions (scope / blocking / notification / expiry / gate boundary)
are USER-CONFIRMED inputs to this ADR, not open questions.

### What exists today

| Loop | Human surface today | Gap |
|---|---|---|
| Reconciler (`bin/session-reconciler.sh`, launchd `com.aigentry.reconciler`, KeepAlive ~60s tick + `bin/policy.py`) | `ESCALATE` → append line to `state/dispatch/verify-escalations.jsonl` | append-only. No blocking, no notification, no resume. |
| Worker autonomous loop (SAWP) | `HOLD:` inject → orchestrator conversation | convention only. No registry status, no resume token; `bin/inject-handler.sh` `hold` arm writes `holds.log` — audit-only. |
| Destructive ops | conversational confirmation (Rule 30 "Git Safety Protocol" row) | no structure at all. |

ADR 2026-06-06 declared `ESCALATE` **"the single human surface"**. `CONTEXT.md:67` records the
overload honestly: *"ESCALATE is also the ambiguity default (when SessionState is unknown, never
act destructively)."* One action name, two jobs.

### Evidence: the overload is 96.7% of the traffic

`state/dispatch/verify-escalations.jsonl`, 2026-06-06 → 2026-07-07 (31 days, 45 distinct sids):

| detail | count | share | what it actually is |
|---|---:|---:|---|
| `ambiguous SessionState surface=unknown` | 94 | 51.4% | ambiguity default — nothing for a human to decide |
| `probe failed: … not found on any dispatcher` (+ 1 node loader crash) | 83 | 45.4% | stale registry entry / probe bug — Rule 30 autonomous |
| `API/transport error requires operator classification` | 6 | **3.3%** | genuine operator decision |
| **total** | **183** | | |

**This refutes design-contract item 2(a) as written.** "Reconciler `ESCALATE` → create gate +
notify" would have produced ~183 gates in 31 days, ~177 of them noise, each demanding a human
close (no expiry, by policy). At one-per-tick without dedup it is ~1,440/day. Worse: any gate
kind that pauses the loop would have been held open by a probe bug.

Two further facts found by reading the code, both load-bearing:

1. **`bin/session-reconciler.sh:264` already declares a gate that does not exist**:
   `emit_alert "REDISPATCH_CAP sid=$sid count=$rdc — user gate required"`. The re-dispatch cap
   breach is the one reconciler condition whose own code says a human must decide.
2. **`bin/inject-handler.sh` has no caller.** Nothing in `bin/`, `src/`, `package.json`, launchd
   plists, or Claude hooks invokes it; `state/dispatch/holds.log` has never been created. The
   `hold` arm is reachable only if something first routes inject bodies into the handler.
   Promoting it (design-contract item 2(b)) would build a producer that cannot fire.

### The SAWP tension is not theoretical

A worker that sends `HOLD:` and waits presents `surface=idle` → Policy `NOOP` ("wait for REPORT
or auto-report evidence") → once `expected_report_by` elapses, `dispatch-tracker.sh check`
(`bin/dispatch-tracker.sh:271`, status ∈ {`in_flight`,`re_dispatched`}) emits **AUTO_REPORT** for
it — i.e. today a worker blocked on a human is eventually recorded as *done*, or re-dispatched.
"Never idle" (docs/sawp.md) and "wait for a human" are structurally incompatible **unless the
waiting state is expressed in the registry**.

## Decision

Add **one primitive: the HITL Gate** — a file in `state/hitl/pending/` plus one CLI
(`bin/hitl.sh`). Blocking is expressed through **state that the loops already filter on**; no new
daemon, no new lock, no new IPC.

Four load-bearing choices:

**1. Split the overloaded `ESCALATE`, don't gate all of it.** `bin/policy.py` gains one Action,
`AWAIT_USER`, and today exactly **one row flips**: `surface == "error"` ("API/transport error
requires operator classification", 6/183). Every other `ESCALATE` row keeps its current
behaviour — log to `verify-escalations.jsonl`, act on nothing. The gate-worthiness predicate is
Rule 30's own boundary table, encoded in the pure function where the rest of the decision table
already lives (ADR 2026-06-06 seam 2), not in a reason-regex in bash.

**2. Blocking = `active.json` status `awaiting_user`.** The loops already filter on status:

| filter | today's set | effect of `awaiting_user` |
|---|---|---|
| `session-reconciler.sh:337` registry loop LIVE | {in_flight, re_dispatched, stuck_welcome} | excluded → **not probed, not acted on** (per-item block, free) |
| `dispatch-tracker.sh:271` AUTO_REPORT scan | {in_flight, re_dispatched} | excluded → **no AUTO_REPORT misfire** (SAWP tension resolved) |
| `dispatch-tracker.sh:390` re-dispatch / `:291` disconnect-mark | {in_flight, re_dispatched} | excluded → no redispatch of a gated worker |
| `session-reconciler.sh:376` `compute_gc_root` LIVE | {in_flight, re_dispatched, auto_reported, disconnected, stuck_welcome} | **must be added** — otherwise the orphan sweep GCs the very session waiting on the human |

Three of four come free; the fourth is a one-word edit and is the single most important line in
this design. *(Belt: add `awaiting_user` to `dispatch-tracker.sh:246` `mark-reported`'s accepted
set, so a worker that reports out-of-band while gated is not silently dropped.)*

**3. Global pause (kind `destructive`) = the existing `--dry-run` path.** A destructive gate
pending ⇒ the tick sets `DRY_RUN=1`. That already means: no `apply_action`, no tracker check, no
comms/bridge auditor, no scheduler tick, no sweep cleanup, no cmux prune — while
`probe → policy.decide → append_shadow_record` still runs. Observation continues, actions stop,
in two lines, over a code path that already has a test (`T29_reconciler_shadow_loop.sh`).

**4. `destructive` means Rule 30's "Commit / push / external destructive" row — never
lifecycle GC.** INV-17 session cleanup, workspace close (Rule 28), Layer-D scheduler fires and
`SEND_KEY`/`RESUBMIT_ENTER` prompt handling stay autonomous. If routine cleanup counted as
destructive the loop would gate itself every tick and deadlock its own pause.

### Gate lifecycle

```
                 hitl.sh open  (idempotent on gate-id)
                        │
                        ▼
                  ┌───────────┐   notify fail  ┌──────────────────────┐
   file written → │  pending  │───────────────▶│ pending, notified_at │
   (before notify)│ (on disk) │◀───retry───────│        = null        │
                  └───────────┘   next tick    └──────────────────────┘
                    │       │
        ┌───────────┘       └────────────┐  reconciler tick, every 24h:
        │                                │  last_reminded_at += re-notify
        ▼                                ▼
  hitl.sh approve <id>            hitl.sh reject <id>
        │                                │
        ├── mv pending/ → decided/  (atomic; second mover fails "already decided")
        ├── restore active.json status ← prev_status  (compare-and-set: only if == awaiting_user)
        └── resume hook by gate.resume:
              reinject                → telepty inject "[APPROVED]|[REJECTED] gate <id> …"
              registry-clear-redispatch → re_dispatch_count = 0 (approve) | status = stuck_error (reject)
              none                    → nothing (manual/info gate)
```

States are **`pending` (file in `pending/`) → `approved`|`rejected` (file in `decided/`)**. There
is no `expired` state — by policy, gates wait indefinitely. The directory *is* the index:
`ls state/hitl/pending/*.json` answers "is anything pending?" without parsing, and the pause
predicate is a `grep -l '"kind":"destructive"'` over that directory. Level-triggered, recomputed
each tick — a daemon restart mid-gate needs no recovery logic (same property the reconcile loop
already relies on).

### Producer flows

**(a) Reconciler gate — re-dispatch cap breach** (replaces the alert at `session-reconciler.sh:264`)

```
tick → probe(sid) → policy → REDISPATCH → maybe_redispatch(sid, ref, rdc)
  rdc >= 1 ─▶ hitl.sh open --source reconciler --subject-sid <sid> --kind decision \
                --resume registry-clear-redispatch \
                --question "re-dispatch cap reached (count=<rdc>) for <sid>" \
                --options "approve=re-dispatch once more,reject=mark stuck_error" \
                --context-ref <ref_path>
              (idempotent: same sid+question → same gate-id → no duplicate, no re-notify)
  ─▶ gate file → notify orchestrator → active.json status = awaiting_user (prev_status stashed)
  ─▶ session drops out of the registry loop + tracker scans; stays in gc_root (not swept)
  ─▶ human: hitl.sh approve <id> → re_dispatch_count=0, status restored → next tick re-dispatches
```

**(b) Reconciler gate — operator classification.** `policy.py` returns `AWAIT_USER` for
`surface == "error"`; `apply_action` gains one arm that calls `hitl.sh open --kind decision
--resume none`. The `verify-escalations.jsonl` line is still written (audit trail preserved).

**(c) Worker HOLD gate.** The `HOLD:` inject already lands in the orchestrator's conversation
(`CONTEXT.md:39`) — that is the reachable path, and the orchestrator is already its only reader.
On receiving a HOLD the orchestrator runs:

```
hitl.sh open --source <worker-sid> --subject-sid <worker-sid> --kind decision \
  --resume reinject --question "<HOLD reason>" --options "…" --context-ref <dispatch ref>
```

which is what converts a conversational HOLD into *structure*: the worker's registry entry goes
`awaiting_user`, so it is no longer AUTO_REPORTed, re-dispatched, or swept — the SAWP "never
idle" envelope stops misfiring on a legitimately waiting worker. `approve` re-injects
`[APPROVED] gate <id> — <note>` and restores the status.

*Not* wired: `inject-handler.sh`'s `hold` arm. It has no caller (see Context); making it fire
requires a telepty-side inject hook, which would give telepty knowledge of orchestrator gate
internals (§9). Deferred to Phase 2, justified only if HOLD volume ever makes the manual `open`
the bottleneck. The dormant arm is left untouched (Rule 29 — noted, not deleted).

**(d) Manual/destructive.** `hitl.sh open --kind destructive --resume none` before a commit /
push / publish / mass-delete / external mutation. This is the only Phase-1 producer of
`destructive`, so the global pause is implemented but rarely armed — deliberate: the mechanism
must exist before the first automated destructive producer does, not after.

### File formats

`state/hitl/pending/<gate-id>.json` → moved to `state/hitl/decided/<gate-id>.json` on decision.

```json
{
  "id": "decision-a740h-hitl-adr-9f2c1a0b3d4e",
  "dedupe_key": "9f2c1a0b3d4e",
  "source": "a740h-hitl-adr",
  "subject_sid": "a740h-hitl-adr",
  "kind": "decision",
  "resume": "reinject",
  "question": "Phase A ADR complete — land as-is or amend scope?",
  "options": ["approve=land + dispatch Phase B", "reject=amend scope first"],
  "context_ref": "state/dispatch/2026-07-26-a740-hitl-adr.md",
  "prev_status": "in_flight",
  "created_at": "2026-07-26T04:12:00Z",
  "notified_at": "2026-07-26T04:12:01Z",
  "last_reminded_at": "2026-07-26T04:12:01Z",
  "status": "pending",
  "decision": null,
  "decided_at": null
}
```

- `id` = `<kind>-<source>-<dedupe_key>`; `dedupe_key` = `sha256("<source>|<kind>|<question>")[0:12]`.
  Deterministic ⇒ a level-triggered producer calling `open` every 60s is a no-op after the first.
- `kind` ∈ `destructive` | `decision` | `info` — blocking semantics (global pause | per-item | none).
- `resume` ∈ `reinject` | `registry-clear-redispatch` | `none` — what `approve` *does*. Two
  producers, two arms, one `case` statement; no config DSL.
- `subject_sid` nullable (a manual destructive gate blocks the loop globally but no single session).
- `notified_at: null` ⇒ notify failed ⇒ retried on the next tick (not after 24h).
- Atomic write = `mktemp` + `mv`, the pattern already used at `session-reconciler.sh:111` and
  `inject-handler.sh:157`. **Not** `src/`'s TS `atomicWrite()` (#114): the gate path must work on
  a fresh checkout with no `tsc` build (Art.17 fallback), and shell is this repo's actuation layer.

> Superseded by Amendment 2026-08-16 (#925). Atomicity is still the invariant; `mktemp`+`mv`
> is no longer the mandated mechanism, and `src/`'s `atomicWrite()` is no longer excluded.
> Note the two distinct primitives the Amendment separates — file *write* vs decide *claim*.

### CLI surface — `bin/hitl.sh` (bash + python3 stdlib, no new deps)

> Superseded by Amendment 2026-08-16 (#925). The CLI contract below — verbs, flags, exit
> codes, the `bin/hitl.sh` path itself — is language-independent and unchanged; the
> "bash + python3 stdlib" implementation note no longer binds.

| command | behaviour |
|---|---|
| `open --source S --kind K [--subject-sid SID] [--resume R] --question Q [--options "a=…,b=…"] [--context-ref PATH]` | write gate (idempotent by id) → notify orchestrator → set `awaiting_user` if `--subject-sid`. Prints gate-id. |
| `list [--kind K] [--json]` | pending gates, oldest first; banner line if a `destructive` gate is pausing the loop. |
| `show <id>` | full record (pending or decided). |
| `approve <id> [--note TEXT]` / `reject <id> [--note TEXT]` | move to `decided/`, restore status (compare-and-set), run resume hook, print resume exit status. Non-zero if already decided. |
| `remind` | internal: notify `notified_at == null` gates now; re-notify gates whose `last_reminded_at` is ≥ 24h old. Called by the reconciler tick. |

Notification is one line reusing the existing REPORT channel — no new transport:

```
telepty inject --submit-force --from <source> orchestrator \
  "HITL_GATE <id> | kind=<kind> | <question> | options: … | decide: bin/hitl.sh approve <id>"
```

### Rule 30 boundary — what is NOT gated (no autonomy regression)

| condition | stays autonomous because |
|---|---|
| codex sandbox/approval prompt, claude trust modal, MCP permission (`SEND_KEY`) | Rule 30 자율 처리 영역 (explicit rows) |
| `RESUBMIT_ENTER` on unsubmitted context-ref | Rule 30 (operational) |
| 1× tracker/reconciler re-dispatch (within cap) | Rule 30 + #736; only the **breach** gates |
| `AUTO_REPORT` emission | Rule 30; user-confirmed boundary |
| `CLEANUP` under the INV-17 multi-signal gate, workspace close, Layer-D scheduler fire | Rule 28/30 — lifecycle GC is not "destructive" in the HITL sense |
| `ESCALATE` ambiguity defaults: `probe failed`, `surface=unknown`, `unhandled surface`, `not alive but death not corroborated` | 96.7% of the log; operational, not decisions. Still logged to `verify-escalations.jsonl`. |
| comms-auditor / bridge-auditor warn-mode HOLDs | warn-only, they take no action |
| **gated** ↓ | |
| reconciler `surface=error` (operator classification) | 3.3%; the row's own text asks for an operator |
| re-dispatch cap breach (2nd+) | `session-reconciler.sh:264` already says "user gate required" |
| worker `HOLD:` phase boundary | phase decision, by definition |
| commit / push / publish / mass-delete / external mutation | Rule 30 Git Safety Protocol row |

### Failure modes

| failure | behaviour |
|---|---|
| orchestrator session down / `telepty inject` fails | file is written **before** notify; `notified_at=null`; `hitl.sh remind` retries every tick; `hitl.sh list` is the pull path (Art.17 fallback — gates never depend on a live transport) |
| daemon restart mid-gate | no in-memory state; pause + reminder recomputed from `pending/` each tick (level-triggered) |
| duplicate gates (60s producer) | deterministic `dedupe_key` ⇒ same filename ⇒ `open` is a no-op, no re-notify |
| stale reminders | `last_reminded_at` + 24h; one re-notify per gate per day, capped to the summary line |
| gated worker died before approval | resume inject fails ⇒ `approve` exits non-zero with `resume_error` recorded in the decided record; status restore still applied, so the normal sweep reclaims the dead session |
| worker reported out-of-band while gated | status restore is compare-and-set (`awaiting_user` only) ⇒ never resurrects a `reported` entry; `mark-reported` belt accepts `awaiting_user` |
| two concurrent `approve` | `mv pending→decided` is atomic; loser exits non-zero "already decided" |
| corrupt / unparseable gate file | **fail-safe**: treated as `destructive` ⇒ tick pauses actions, logs `HITL_GATE_CORRUPT <file>` loudly. Consistent with the loop's existing ESCALATE-default bias (never act when ambiguous). Writes are atomic, so this implies tampering/disk fault, not a truncated write. |
| destructive gate never answered | actions stay paused indefinitely and the cleanup backlog grows — **accepted**, per the user's no-expiry policy. Mitigations: 24h reminder, `HITL_PAUSE gate=<id>` logged every tick, `hitl.sh list` banner. |
| clock skew / test determinism | all timestamps via the existing `now_iso()` (honours `RECONCILER_NOW`) |

### Migration / rollout order

| step | change | why this order |
|---|---|---|
| **M0** | tests T61–T66 written **failing** (Rule 35 reproduce-first) | evidence before code |
| **M1** | `awaiting_user` added to `compute_gc_root` LIVE (`session-reconciler.sh:376`) + `mark-reported` tuple (`dispatch-tracker.sh:246`) | **must precede any status write** — otherwise a gated worker is GC'd |
| **M2** | `bin/hitl.sh` + `state/hitl/{pending,decided}/` | standalone; usable manually the moment it lands (covers producer (c) and (d)) |
| **M3** | reconciler: pause check (`DRY_RUN=1`) + `hitl.sh remind` call in the tick | 2 small edits over an already-tested path |
| **M4** | `policy.py` `AWAIT_USER` + `apply_action` arm + `maybe_redispatch` cap → `hitl.sh open` | producers (a),(b); the only behaviour change to the decision table |
| **M5** | docs: `CONTEXT.md` glossary, `docs/rules.md` pointer, AGENTS.md checklist row | after behaviour is real |

**Naming collision (must be handled in M5).** `src/gate/` + `docs/gate-architecture.md` already
own "Gate" = the **spawn-capability gate** (Class A/B/C, `enforceSpawn`, ADR-MF #15). The new term
is **HITL Gate** (paths `state/hitl/`, `bin/hitl.sh`, log prefix `HITL_GATE`) — no code collision,
but `CONTEXT.md` must define both entries side by side or the domain language drifts.

### Test plan sketch (failing-first, `tests/dispatch/`, next free number = T61)

Existing seams suffice: `tests/dispatch/lib.sh`, `stubs/` (telepty stub), `RECONCILER_NOW`,
`DISPATCH_STATE_DIR`. No new test infrastructure.

| test | asserts (fails before implementation) |
|---|---|
| `T61_hitl_open_idempotent.sh` | two identical `open` calls ⇒ 1 file in `pending/`, telepty stub received **1** inject |
| `T62_hitl_blocking_status.sh` | `open --subject-sid` ⇒ status `awaiting_user`; reconciler tick does **not** probe it (probe stub count 0) **and** `compute_gc_root` still contains it (not swept) ← the regression that matters |
| `T63_hitl_destructive_pause.sh` | pending `destructive` gate ⇒ tick takes zero actions (cleanup/dispatch/send-key stubs at 0) **but** `reconcile-shadow.jsonl` still grows |
| `T64_hitl_approve_resume.sh` | `approve` ⇒ file in `decided/`, status restored to `prev_status`, telepty stub saw `[APPROVED]`; second `approve` exits non-zero |
| `T65_hitl_reminder_24h.sh` | `RECONCILER_NOW` +25h ⇒ exactly one re-notify; +1h ⇒ zero; `notified_at=null` ⇒ immediate retry |
| `T66_policy_await_user.sh` | `policy.py` `surface=error` ⇒ `AWAIT_USER`; `surface=unknown` ⇒ still `ESCALATE` ← guards the autonomy boundary against future drift |

Registered under `tests/dispatch/run-all.sh` (auto-globs `T*.sh`), which is run on its own —
**not** by `npm test` (`scripts/run-tests.mjs` enumerates compiled tests under `dist/tests` only,
so no shell test has ever been reachable from it). Corrects the original claim; found by W1a.

## 위헌 심사 (Constitutional review — 5문항)

| # | Question | Verdict |
|---|---|---|
| 1 | 전문 목적 — AI 기술 격차 해소에 복무하는가? | **Pass.** A *structural* gate is what lets a non-expert run an autonomous fleet: the loop keeps running and the human is asked only where judgment is genuinely required (3.3% of today's escalations). Without it the only options are full autonomy (unsafe on destructive ops) or full babysitting (no leverage) — both widen the gap. |
| 2 | 이 기능은 어느 컴포넌트의 역할인가? (제3조) | **Pass.** Decision **policy** + gate state = orchestrator (`state/hitl/`, `bin/hitl.sh`, `policy.py`). **Transport** = telepty, via its existing public `inject` CLI. telepty learns nothing about gates; no role bleed. |
| 3 | 이 프레임워크/라이브러리가 정말 필요한가? (제1조 경량) | **Pass.** One ~150-line shell script + 1 new Action enum value + 1 flipped policy row + 2 one-word set edits + a 2-line pause that **reuses the existing `--dry-run` path**. No new daemon (the 60s tick already exists — ADR 2026-06-06 rejected new daemons for the same reason), no new module, no lock file, no library. Deletion test: remove `hitl.sh` and blocking/notify/resume scatter back into conversational convention — i.e. today's state. |
| 4 | 이 컴포넌트 없이도 다른 컴포넌트가 동작하는가? (제9조 독립) | **Pass.** Gate files live entirely in the orchestrator's state dir; telepty is called only through its public CLI and requires **zero** change. If telepty is down, gate creation still succeeds (file first, notify second) and `hitl.sh list` is the pull path. Conversely, deleting `state/hitl/` leaves every loop working exactly as it does today. |
| 5 | 안전장치가 동반되어 있는가? (제14조) | **Pass.** (i) fail-safe on corrupt gate files (pause, not proceed) — same bias as the loop's ESCALATE default; (ii) compare-and-set status restore (never resurrects a reported entry); (iii) `awaiting_user` added to `gc_root` so a gated worker is never swept; (iv) idempotent gate-ids prevent notification floods; (v) rollout is staged, M1 (sweep protection) strictly before any status write. |

Remaining checklist items are unaffected and Pass: 제2조 (bash + python3 stdlib only, same
cross-OS profile as every other `bin/` script), 제10조/제11조 (one command, no new workflow
imposed), 제15조 (M5 registers `HITL Gate` + `AWAIT_USER` in `CONTEXT.md`).

> Superseded by Amendment 2026-08-16 (#925) — the 제2조 row only. "Same cross-OS profile as
> every other `bin/` script" was a *relative* pass that has since gone stale: #899 moved the
> peer scripts to `dist/`, so bash + python3 is now the outlier, not the profile. Re-reviewed
> in the Amendment's 위헌 재심사. 제10조/제11조/제15조 are untouched.

**Verdict: PASS.** No constitutional conflict; no orchestrator waiver required.

## Rule 4-A — execution mode for the implementation phase

**Mode = D (Dispatch).** Selector trace (phase6-conclusion §4.2.2, evaluation order B1→B6):
B1 no (Claude-only chain supported) → B2 no (`session_count ≥ 1`; the a740h chain is already
accumulated, so B2 cannot preempt) → B3 no (not `explicit_reuse`) → B4 no (workload is not
`default`) → **B5 `workload = external_dispatch` → D**. C6 caveat honoured: D carries Layer-1
co-equal status but **no cross-CLI verified claim** — implementation is a Claude coder session.

Parallel breakdown (Rule 9 / Rule 36 — different files, no overlap):

| wave | files | depends on |
|---|---|---|
| W1a | `bin/hitl.sh` (new) + T61/T64/T65 | — |
| W1b | `bin/policy.py` + T66 | — (runs in parallel with W1a) |
| W2 | `bin/session-reconciler.sh` + `bin/dispatch-tracker.sh` + T62/T63 | W1a (needs `hitl.sh`) |

Each wave registered in `state/task-queue.json` before dispatch (Rule 34; `bin/dispatch.sh`
enforces `--task`).

## Consequences

- **Positive.** `ESCALATE` finally means one thing (ambiguity default, log-only) and the human
  surface becomes a first-class, resumable object. The SAWP "never idle" envelope stops
  misfiring on gated workers. The re-dispatch-cap gate that the code has been asking for since
  2026-06 exists. Destructive pause is a two-line reuse of a tested path. Nothing that is
  autonomous today becomes manual.
- **Negative / accepted.** No expiry means a forgotten `destructive` gate halts autonomous
  actions indefinitely (mitigated by reminder + per-tick log + `list` banner, accepted by
  policy). One more registry status value to reason about. A second meaning for "gate" in the
  domain language, which M5 must disambiguate.
- **New domain terms** (`CONTEXT.md`, M5): **HITL Gate**, `awaiting_user`, `AWAIT_USER`,
  and a disambiguation note against the existing spawn **Gate** (Class A/B/C).

## Rejected

- **Gate every `ESCALATE`** (design-contract 2(a) as written) — 177/183 of them are ambiguity
  defaults; would flood the human surface and, with pause semantics, wedge the loop on a probe bug.
- **Promote `inject-handler.sh`'s `hold` arm now** (design-contract 2(b)) — the handler has no
  caller and `holds.log` has never existed; wiring it needs a telepty-side inject hook, coupling
  telepty to orchestrator gate internals (§9). The reachable producer today is the orchestrator
  conversation, which is where HOLDs already land. Dormant arm left in place (Rule 29).
- **A new blocking mechanism (lock file / `hitl-pause` flag / new daemon)** — `active.json` status
  is already the filter every loop reads; `--dry-run` is already the pause. §1.
- **Gate-worthiness as a reason-regex in `session-reconciler.sh`** — would re-scatter decision
  logic across the glue layer, the exact smear ADR 2026-06-06 collapsed into `policy.py`. As an
  Action value it is unit-testable on fixtures (T66).
- **A TS gate module reusing `src/`'s `atomicWrite()` (#114)** — puts a `tsc` build on the gate
  path (Art.17 fallback broken) and adds a fourth `dist/` seam to a `src/` that is already ~50%
  production-dormant. Shell `mktemp`+`mv` is the established actuation-layer pattern.

  > Superseded by Amendment 2026-08-16 (#925). Both premises were re-measured and both have
  > expired: the gate path already requires `dist/` through its own producers, and `src/` is
  > the actuation layer now rather than a dormant one. This alternative is accepted.
- **Expiry / auto-approve after N hours, and push/desktop notification** — excluded by
  user-confirmed policy (2026-07-26).

---

## Amendment (2026-08-16, #925) — the CLI contract is language-independent

**Decision (user, 2026-08-16):** *"amend the ADR then port — that is the permanent fix."*
`bin/hitl.sh` MAY be reimplemented in TypeScript under `src/`, with `bin/hitl.sh` retained as
an exec shim over `bin/lib/node-shim.sh`, exactly as `bin/dispatch.sh` (#899 T1) and
`bin/dispatch-tracker.sh` (#899 T1b) already are. Unblocks **#899 T2d**.

**Nothing about gate behaviour changes.** The file format, the gate-id derivation, the
directory index, the CLI argv and the env surface are the contract. The implementation
language was never the contract — the 2026-07-26 text made it one by accident, as a
side-effect of two premises that have since expired.

### Why the original reasoning no longer holds (re-measured at `c83ebc4`, 2026-08-16)

**1. The build-free gate path is already gone — its own producers require `dist/`.**
`bin/hitl.sh` has exactly two callers, and nothing else in or outside the repo invokes it:

| caller | state at `c83ebc4` |
|---|---|
| `bin/session-reconciler.sh:68,274,884` (`HITL_SH`, `hitl_open`, `remind`) | bash today, **being ported to TS in #899 T2c** |
| `src/tracker/cli.ts:61,456` (`HITL_SH`, `runQuiet`) | **already TS**; `bin/dispatch-tracker.sh` is an exec shim |

Once T2c lands, *both* producers need `dist/` before they can call the gate at all. A gate that
runs without a build protects nothing, because nothing can reach it without one. The premise
"the gate path must work on a fresh checkout with no `tsc` build" describes a path that no
longer exists.

CI already encodes this ordering: `.github/workflows/ci.yml:66-70` and
`.github/workflows/release.yml:110-114` run `npm test` (which is `tsc -p . && …`) **before**
`bash tests/dispatch/run-all.sh`, with the comment *"several guards gate on dist/ being built,
and `npm test` is what builds it"* (#900). The shell guard suite has not been build-free since
that landed.

**2. Article 17 is satisfied by the package, not by the language.** `package.json` `files[]`
ships `dist/src`, and `prepack` runs `npm run build` — so a public user who installs
`@dmsdc-ai/aigentry-orchestrator` alone receives compiled JS and needs no toolchain (제17조 ①).
`bin/lib/node-shim.sh` resolves `dist/` in both real layouts — package/repo sibling, or the
control workspace via the package's own CLI on `PATH` — and **fails loud with exit 2** when
neither resolves, rather than degrading silently (제17조 ④: the fallback is a stated failure,
not a hidden one; pinned by T99/T100 and `tests/packaging/smoke-init.sh`). That shim *is* this
repo's Article 17 story now; the ADR predates it.

Node is not a new dependency either: `bin/init/cli.mjs` is the package's only `bin` entry and
`engines.node >= 20`, so node is a hard prerequisite of installing the orchestrator at all.
python3 is the *additional* one — and it is not guaranteed on either macOS (Command Line Tools)
or Windows.

**3. `src/` is no longer "~50% production-dormant".** #899 moved the actuation layer into it —
T1 dispatch (`dc766db`), T1b tracker (`d7a2777`), pre-T2 `wh-cli` (`c83ebc4`), T2a cleanup in
flight. The rejected alternative's second premise fails on the same measurement as its first.

**4. `atomicWrite()` is now the *stronger* primitive, not the weaker one.** `#901` gave
`src/session/persistence/atomic-write.ts` win32 arms: write → `fsync` → rename with a bounded
retry over the transient `EPERM`/`EACCES`/`EBUSY` window, plus a documented (not faked)
limitation on the parent-directory fsync. `mktemp`+`mv` in bash has none of that and does not
execute natively on Windows at all.

### Invariants — the actual contract, unchanged by the port

The port is a **behaviour-preserving** rewrite. Guards `T61`, `T62`, `T63`, `T64`, `T65` and
`T74` pin these and must stay green **without being edited**; a guard that needs editing to
pass is evidence the port broke the contract, not evidence the guard was wrong.

1. **Layout & lifecycle.** `state/hitl/pending/<id>.json` → `state/hitl/decided/<id>.json`.
   The directory *is* the index; `ls pending/` answers "is anything pending?" without parsing.
2. **Record schema** exactly as §File formats — same keys, same names, same types, including
   `notified_at: null` as the "notify failed, retry next tick" signal.
3. **Deterministic id.** `id = <kind>-<source>-<dedupe_key>`,
   `dedupe_key = sha256("<source>|<kind>|<question>")[0:12]`, lowercase hex. Node's
   `crypto.createHash("sha256")` must reproduce ids **byte-identically**, or in-flight gates
   written by the bash version stop resolving and idempotency silently breaks.
4. **Enums.** `kind ∈ destructive | decision | info`; `resume ∈ reinject |
   registry-clear-redispatch | none`.
5. **Two distinct atomicity primitives — do not collapse them into one call.**
   - *Gate-file write* (`hitl.sh:67-77`, `168-196`): `mktemp`+`mv` ≡ `atomicWrite()`. Gate ids
     contain no path separator, so they are legal `sessionId` values for it.
   - *Decide claim* (`hitl.sh:286-287`): `mv pending/<id>.json → decided/.<id>.claim.XXXXXX`
     is a **mutex, not a write** — the first mover wins the record and the loser must get
     `ENOENT` and exit non-zero `"already decided"` (T64). `atomicWrite()` cannot express
     this; use a bare `rename` plus an `ENOENT` branch. On win32 the transient
     `EPERM`/`EACCES`/`EBUSY` set may be retried; **`ENOENT` must never be** — it is the
     loser's answer, not a fault.
6. **Level-triggered blocking.** A pending `destructive` gate ⇒ `DRY_RUN=1` for the tick;
   an unparseable gate file is treated as `destructive` (fail-safe). Recomputed each tick, so
   a restart mid-gate still needs no recovery logic.
7. **Reminder cadence.** `notified_at == null` ⇒ retry immediately on the next tick;
   otherwise re-notify when `last_reminded_at` is ≥ `HITL_REMIND_INTERVAL` (default 24h).
8. **Env surface, preserved verbatim** — `HITL_STATE_DIR`, `DISPATCH_STATE_DIR`,
   `DISPATCH_REGISTRY_PY`, `TELEPTY`, `ORCHESTRATOR_SID`, `RECONCILER_NOW`,
   `HITL_REMIND_INTERVAL`. The guards drive the implementation entirely through these:
   `HITL_STATE_DIR` at 25 sites and `RECONCILER_NOW` at 19 across T61–T65/T74.
9. **`bin/hitl.sh` must remain an executable file at that path.** Both callers gate on it —
   `session-reconciler.sh:270` (`[ -x "$HITL_SH" ]` ⇒ `HITL_GATE_UNAVAILABLE`) and
   `src/tracker/cli.ts:452` (`executable(HITL_SH)`) — and it is a literal entry in
   `bin/init/manifest.mjs`, which `tests/packaging/T96_ship_set_agreement.sh` holds against
   both the real tarball and `git ls-files`. Replacing the file with a `src/`-only module
   would take the gate offline in every control workspace and fail T96. The shim is not
   ceremony; it is the contract.
10. **No sourceable-library mode is owed.** Measured: none of the six guards sources
    `bin/hitl.sh` or reaches into its functions — all drive it as a subprocess CLI. The port
    therefore needs **no** `__probe` subcommands, unlike `bin/dispatch.sh`, whose 12 guards
    depended on `DISPATCH_SH_NO_MAIN` (#899 T1). This is the cheapest port of the tranche.

Out of scope: `T66_policy_await_user.sh` pins `bin/policy.py`'s `AWAIT_USER` row, not the gate
CLI. `bin/policy.py` is untouched by T2d.

### What the port does NOT fix (Rule 38 — stated, not glossed)

The registry status write still shells to `bin/dispatch-registry.py` (`hitl.sh:101`
`registry()`), so **python3 remains on the gate path after T2d**. That is not a regression and
not an oversight: the already-ported CLIs do exactly the same — `src/tracker/cli.ts:160` and
`src/dispatch/cli.ts:243` keep `dispatch-registry.py` as a subprocess with identical argv, by
design (`src/tracker/cli.ts:10`).

So the accurate claim is narrow: T2d removes python3 from **hitl's own logic** — the eight
heredocs at `hitl.sh:48,53,68,85,150,171,221,347` (timestamps, sha256, JSON read/modify/write,
options parsing, listing, remind arithmetic) — and leaves the one shared python3 seam that
every ported peer already carries. "The port closes the Windows hole in the safety gate" would
be an overstatement and should not be written into T2d's PR.

Windows support is *declared absent* today: `package.json` `os: ["darwin","linux"]`, and
`npm ci` refuses on win32 with `EBADPLATFORM` (U23, asserted in `ci.yml`). The Windows CI leg
is a debt-tracking job whose own comment reads *"the honest reading of a green W1 is 'the code
runs on win32 when you force it past the refusal', never 'Windows is supported'"*. What the
port actually buys is narrower and still worth having: it moves the gate's logic out of a tier
that **can never be exercised** on win32 (bash guards cannot run there at all) into the tier
that the W1 job does exercise, with a tracked failure count. Unmeasurable surface → measured
debt.

### Sequence

**T2c** (`bin/session-reconciler.sh` → TS) → **this amendment** → **T2d** (`bin/hitl.sh` → exec
shim + `src/hitl/`). The amendment lands first so T2d's PR cites a recorded decision instead of
re-litigating one inside a code review, and so the two superseded passages above never contradict
merged code.

### 위헌 재심사 (delta only — the rows this amendment moves)

| # | Question | Verdict |
|---|---|---|
| 제1조 경량 | Is a language port over-engineering? | **Pass.** No new dependency, no new module boundary, no new state. It removes one runtime (python3) from hitl's own logic and reuses two primitives that already exist and already have tests: `node-shim.sh` and `atomicWrite()`. Deletion test unchanged — remove the gate and blocking/notify/resume scatter back into conversational convention. |
| 제2조 크로스 | Cross-OS. | **Pass, upgraded.** The 2026-07-26 pass was relative ("same profile as every other `bin/` script") and went stale when #899 moved the peers to `dist/`. bash + python3 is now the outlier. The port does not deliver Windows support — see the section above — but it stops the safety gate from being the one component that cannot even be measured there. |
| 제17조 무의존 | Zero external dependency. | **Pass.** Article 17 is served by the published package (`files[]` ships `dist/src`; `prepack` builds it), not by avoiding a compiler. `node-shim.sh` supplies the required fallback path as a loud exit 2, and node is already the orchestrator's install-time prerequisite. |
| 제14조 안전 가드 | Safety gate. | **Unchanged.** Fail-safe on corrupt files, compare-and-set status restore, `awaiting_user` in `gc_root`, idempotent ids, first-mover-wins claim — all five are invariants 1-7 above and are pinned by T61-T65/T74, which the port may not edit. |

**Verdict: PASS.** No constitutional conflict; no orchestrator waiver required.
