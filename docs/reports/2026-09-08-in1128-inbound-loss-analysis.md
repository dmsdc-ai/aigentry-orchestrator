# in1128 — Diagnosis: the four inbound HOLDs of 2026-09-08 were never written to the orchestrator

**Task** #1128 · **Role** analyst (runtime evidence only; no production modification, no live probe, no test run)
**Written** 2026-09-08 KST · **Branch** `docs/1128-inbound-loss-analysis` · **Worktree** `~/.aigentry/worktrees/in1128`

---

## 0. Verdict in one paragraph

All four HOLD injects sent to `orchestrator` on 2026-09-08 between 08:02:41 and 08:05:16 KST were **NOT
DELIVERED** — measured, not inferred: `bytes_written: 0` in the daemon's durable observation ledger, at
both the park and the drop. They were parked on the orchestrator session's bootstrap/modal queue because
the orchestrator's Claude surface was showing a blocking `AskUserQuestion` modal opened 47 seconds
earlier, and all four were **discarded** when the 600 s modal-park TTL expired at 08:12:41–08:12:42 KST.
The classification is *not delivered*; it is not "delivered but not submitted", not "consumed but
unanswered", and not "evidence unavailable". The daemon-restart / old-bridge hypothesis is **falsified**:
one continuous daemon process spanned the park and the flush. The payloads survived only because
`--ref` wrote them to `~/.telepty/shared`, and — a fact the dispatch did not anticipate — the existing
`dispatch-tracker.sh report-sweep` **already captured all four into `state/dispatch/inbox/` within 20–61
seconds**, before the daemon discarded them. Capture was never the missing piece. Notification was.

---

## 1. Measurement scope and provenance

### 1.1 Repository SHAs measured

| Repo | SHA | Committed | Note |
|---|---|---|---|
| `~/projects/aigentry-orchestrator` | `19949e03d91e6d72a3d82f42a4d924229e1cf168` | 2026-09-08T20:18:16+09:00 | `main`, working tree dirty (`state/task-queue.json` modified + untracked scratch files); this report's branch forks from it |
| `~/projects/aigentry-telepty` | `997ea7c7d98b1dbc420e2e6de95d455a150e1b2c` | 2026-09-08T19:55:07+09:00 | `main`, `0.8.3` — the tree running **now**, released **after** the incident |
| `~/projects/aigentry-telepty` | `a79aca9583352ccdd91c5239c69762400d00d734` | 2026-09-07T22:33:03+09:00 | `0.8.2` — the tree whose code ran **during** the incident |

`git diff a79aca9 HEAD -- daemon.js` is **4 lines**, all of them the `#1124` bind-port change
(`resolveBindPort`). Every function in the causal chain below (`deliverInjectionToSession`,
`parkOperationOnModal`, `scheduleModalParkDrain`, `flushModalParkQueue`, `deliveryAuditResult`,
`parkTrackedInjection`, `abortTrackedInjection`) is byte-identical between the incident tree and current
`main`. **The defect is live in 0.8.3.**

### 1.2 Timezone

Every machine record cited (`injects.jsonl`, `tracked-injections.json`, `reconciler.log`, Claude
transcripts, `session-deaths.log`) is timestamped in **UTC** with a `Z` suffix. KST = UTC+9. Filesystem
mtimes shown via `ls -laT` are **local (KST)**. Both are given below wherever a time appears;
`08:02:41 KST` = `2026-09-07T23:02:41Z`.

### 1.3 Evidence locations (absolute, no secrets)

| Evidence | Path | What it proves |
|---|---|---|
| Signed inject audit | `/Users/duckyoungkim/.telepty/logs/injects.jsonl` (2942 lines) | per-inject `delivery_result`, sender verification, payload sha/bytes |
| Durable observation ledger | `/Users/duckyoungkim/.config/aigentry-telepty/tracked-injections.json` (16.8 MB, schema v2, 1473 records) | per-inject park/drop with **measured `bytes_written`** |
| Daemon console log | `/Users/duckyoungkim/Library/Logs/aigentry-orchestrator/telepty-daemon.log` (63 229 lines) | `[MODAL] … parked`, `[MODAL] … park TTL expired … flushed 4 op(s)`, restart boundaries |
| Reconciler log | `/Users/duckyoungkim/Library/Logs/aigentry-orchestrator/reconciler.log` | `NEW … REF/HOLD state/dispatch/inbox/…` — the report-sweep capture |
| Orchestrator transcript | `/Users/duckyoungkim/.claude/projects/-Users-duckyoungkim-projects-aigentry-orchestrator/7c052aff-17f1-4c28-8442-73209317bdac.jsonl` (11.5 MB, 5304 timestamped entries, span 2026-09-05T11:15:56Z → 2026-09-08T11:59:52Z) | the modal, the 10 h 39 m turn gap, the manual recovery |
| Worker transcripts | `/Users/duckyoungkim/.claude/projects/-Users-duckyoungkim--aigentry-role-sandbox-coder-{tp1127-tp1127-release-verify-wait,tp1125-tp1125-survivor-port,ah1117-ah1117-phase3-instrument,tp1099-tp1099-screen-apc}/*.jsonl` | the exact `telepty inject` argv and the exit-0 `✅` the workers saw |
| Retained payloads | `/Users/duckyoungkim/.telepty/shared/{f08331e9…,71c43d68…,c487ed45…,aa546177…}.md` | the four HOLD bodies, still on disk, sha256 = filename |
| Inbox copies | `/Users/duckyoungkim/projects/aigentry-orchestrator/state/dispatch/inbox/2026-09-07-{tp1127-f08331e9…,tp1125-71c43d68…,ah1117-c487ed45…,tp1099-aa546177…}.md` | the sweep captured all four before the drop |
| Session lifecycle | `/Users/duckyoungkim/.telepty/logs/session-deaths.log` | orchestrator session alive throughout; worker SIGTERM times |
| Daemon identity | `/Users/duckyoungkim/.telepty/daemon-state.json` | pid 36681, `0.8.3`, `startedAt 2026-09-08T10:53:05.838Z` — **post-incident** |

### 1.4 What this measurement EXCLUDES

- **No live probe was run.** No inject was sent, no daemon restarted, no cursor or mailbox touched, no
  test executed. Every statement is a read of a record written at the time.
- **`bin/dispatch-tracker.sh report-sweep` was not executed by me.** Its behaviour is read from
  `src/tracker/report-sweep.ts` plus the `reconciler.log` lines its 2026-09-08 08:0x runs actually printed.
- **The daemon console log carries no per-line timestamps.** Its lines are ordered against
  `injects.jsonl` / the ledger by inject_id, which is exact for every claim made from it. Where I say
  "at 08:12:41" the time comes from the ledger, not from the console log.
- **No screen capture of the orchestrator surface at 08:02 exists.** That the surface was modal is
  established by the daemon's own detector verdict (`claude_modal_ui`) recorded four times in two
  independent stores, plus the transcript's `AskUserQuestion` tool call — not by a screenshot.
- **The `[AUTH] Rejected unauthorized request from 127.0.0.1` line adjacent to the first park is NOT
  implicated.** 56 such lines exist across the whole log; only one falls near the window and it precedes
  a park that the ledger attributes to `claude_modal_ui`. Recorded as unexplained background, not cause.
- **Mailbox/bridge state at 08:02 is gone.** Not needed: the inject route never reached the mailbox path
  (§3, step 3), so its state cannot bear on this loss.

---

## 2. Corrections to the handed starting set

The dispatch supplied names, counts and times "copied from task 1128, not newly verified". Re-measured at
source:

| Handed claim | Measured | Verdict |
|---|---|---|
| tp1127 08:02, tp1125 08:03, ah1117 08:04, tp1099 08:05 | 08:02:41, 08:03:04, 08:04:19, 08:05:16 KST | **CONFIRMED** (to the second) |
| Four missed HOLD notifications | Exactly four, all four `delivery_result: "queued"`, all four `bytes_written: 0` | **CONFIRMED** |
| Workers waited ≈ 11 hours | 11 h 37 m 45 s – 11 h 39 m 56 s (HOLD sent → GO received) | **CONFIRMED**, refined |
| tp1124 at 18:43/18:50 did arrive | tp1124→orchestrator at 18:43:47, 18:47:02, 18:50:50 KST, all `delivery_result: "success"` | **CONFIRMED** |
| Manually recovered "around 18:5x" | Recovery read at **19:41:55 KST**; re-dispatch 19:42:36–19:43:01 | **CORRECTED — off by ≈ 50 min.** 18:41–18:50 is when the *user answered the modal* and the tp1124 exchange resumed; the four lost HOLDs were not noticed until 19:41 |
| "Daemon-restart / old-bridge explanation is a hypothesis" | Last restart before the loss 2026-09-07T17:10:54.597Z (02:10:54 KST, **5 h 51 m before**); next restart 2026-09-08T10:53:05.882Z (19:53:05 KST, **11 h 40 m after the drop**) | **FALSIFIED** (§5.1) |
| "Handoff reported telepty 0.8.3 running" | 0.8.3 daemon started 19:53:05 KST — **after** everything. The incident ran **0.8.2** (`a79aca9`) | **CORRECTED** |
| Desired guard: durable recovery of inbound refs "through the existing report-sweep/reconcile path" | That path **already exists, already ran, and already captured all four** (§6) | **PARTIALLY ALREADY SUPPLIED** — the missing half is notification, not capture |

One further correction, upstream-relevant: the HOLD protocol in the dispatch template mandates
`telepty inject --ref --submit --submit-force`. **None of the four workers used `--submit` or
`--submit-force`** (§5.3). This did not cause the loss, but it is a real protocol deviation and it changes
what a fix must assume.

---

## 3. The proven causal chain

Read in order; each step cites the record that establishes it.

**Step 1 — 08:01:54.465 KST (`2026-09-07T23:01:54.465Z`): the orchestrator opens a blocking modal.**
Orchestrator transcript, `assistant` turn, `tool_use` name `AskUserQuestion`, question text beginning
`"#1124: telepty 데몬이 바인드 포트를 TELEPTY_PORT → PORT → 3848 순으로 읽게 바꿀까요?"`. In the Claude Code TUI
this renders a modal list that consumes Enter and blocks the composer until a human answers.

**Step 2 — the daemon detects it.** `daemon.js:2692 isSurfaceBlockedByModal()` reads the session output
ring tail and asks `readyRegistry.detectSurfaceModal(session.command, tail)`; for `claude` the verdict
reason is `claude_modal_ui` (`src/prompt-symbol-registry.js:98,167`). For a `claude` session the remedy
default is **`park`**, not `hold`/`reject` (`daemon.js:2719 MODAL_REMEDY_BY_CLI = { claude: 'park' }`), with
the rationale written in the source: *"an AskUserQuestion list or an ExitPlanMode approval waits on a
HUMAN and routinely stays up for minutes (#743: 3 REPORTs lost across one plan window)."*

**Step 3 — 08:02:41 → 08:05:16 KST: four injects park, zero bytes written.**
`deliverInjectionToSession` (`daemon.js:2956`) reaches the modal branch, calls
`parkOperationOnModal(...)` then `parkTrackedInjection(injectId, 'bootstrap_queue', 'claude_modal_ui')`
(`daemon.js:3020`), and returns `modalParkResponse(...)` — an HTTP **200**. The mailbox path below is
never reached.

Daemon console, in order, immediately after the four 08:00 outbound dispatches:

```
[MODAL] orchestrator inject parked — claude_modal_ui (depth 1)
[INJECT] Queued for session orchestrator (inject_id: 223af96b-7b27-4844-9fc9-1e453d51825b)
[MODAL] orchestrator inject parked — claude_modal_ui (depth 2)
[INJECT] Queued for session orchestrator (inject_id: a8e21ae5-b5ad-4a19-86c4-41e1a3e63f02)
[MODAL] orchestrator inject parked — claude_modal_ui (depth 3)
[INJECT] Queued for session orchestrator (inject_id: f079fe31-91f8-494a-839d-3f4e42a4f924)
[MODAL] orchestrator inject parked — claude_modal_ui (depth 4)
[INJECT] Queued for session orchestrator (inject_id: 185f1cfc-dd6d-42d0-83db-5340005ed22b)
```

**Step 4 — the audit says `queued`, and `queued` is not `success`.**
`injects.jsonl` records `delivery_result: "queued"` for all four. `deliveryAuditResult`
(`daemon.js:818`) returns `queued` only for `delivery.queued === true && delivery.strategy ===
'bootstrap_queue'`, whose docblock states the meaning outright: *"`queued` is that third state: accepted
and parked, nothing written."* Every other worker→orchestrator inject that day — 18:43 through 20:17 —
records `success`. The four are the only `queued` lines in the window.

**Step 5 — 08:12:41.930 → 08:12:42.226 KST: the TTL expires and all four are DISCARDED.**
`scheduleModalParkDrain` (`daemon.js:2915`) arms a 500 ms poll with a single deadline of
`Date.now() + 600000`. The surface was still modal, so `flushModalParkQueue` (`daemon.js:2848`) ran:
`session.bootstrapQueue.splice(0, queued)` — the ops are removed and **never re-attempted**. For each,
`abortTrackedInjection(..., 'SURFACE_MODAL_PARK_TIMEOUT', ..., { kind: 'inject_delivery_dropped' })`.

```
[MODAL] orchestrator park TTL expired after 600000ms — flushed 4 op(s)
```

**Step 6 — the ledger records the loss honestly, and nothing reads it.** Ledger record for
`223af96b-…` (`session_id: orchestrator`, `session_epoch: 01Bvy_QPjCITTsdL_fHFGw`,
`transport_source: tp1127-tp1127-release-verify-wait`, `tracking_state: aborted`):

```json
{"kind":"tracking_started","trigger":"inject_accepted","seq":1,"at":"2026-09-07T23:02:41.360Z"}
{"kind":"inject_parked","trigger":"bootstrap_queue","reason":"claude_modal_ui","bytes_written":0,"seq":2,"at":"2026-09-07T23:02:41.427Z"}
{"kind":"tracking_superseded","trigger":"superseded_by_new_tracked_inject","superseded_by":"a8e21ae5-…","seq":3,"at":"2026-09-07T23:03:04.528Z"}
{"kind":"inject_delivery_dropped","trigger":"surface_modal_park_timeout","delivery_code":"SURFACE_MODAL_PARK_TIMEOUT",
 "delivery_error":"parked behind a surface modal that did not clear within 600000ms","bytes_written":0,"seq":4,"at":"2026-09-07T23:12:41.930Z"}
{"kind":"daemon_restart_observed","trigger":"daemon_restart","seq":5,"at":"2026-09-08T10:53:05.882Z"}
```

The other three are identical in shape (tp1099's has no `tracking_superseded`, being last).

**Step 7 — 18:41:15 KST: the human answers, 10 h 39 m 20.9 s after the modal opened.**
The orchestrator transcript has **zero entries** between `2026-09-07T23:01:54.465Z` and
`2026-09-08T09:41:15.314Z`. The next entry is the `AskUserQuestion` result. None of the four HOLD bodies
appears anywhere in the transcript before the manual recovery at `2026-09-08T10:41:55.891Z` — searched by
both payload first-line and shared-file sha prefix. The bytes never reached the model.

### 3.1 Per-message timeline (all times KST; UTC in the source records)

| # | Worker | Payload (`~/.telepty/shared/…md`) | Enqueue / audit | Parked (`bytes_written`) | Dropped | Delivered? | Submitted? | Consumed? | Answered |
|---|---|---|---|---|---|---|---|---|---|
| 1 | tp1127-release-verify-wait | `f08331e9…` 2 214 B | 08:02:41.360 / .489 `queued` | 08:02:41.427 · **0** | 08:12:41.930 | **NO — 0 bytes** | n/a (no CR sent) | **NO** | 19:42:37 (re-dispatch) |
| 2 | tp1125-survivor-port | `71c43d68…` 3 345 B | 08:03:04.528 / .686 `queued` | 08:03:04.617 · **0** | 08:12:42.058 | **NO — 0 bytes** | n/a | **NO** | 19:42:36 |
| 3 | ah1117-phase3-instrument | `c487ed45…` 4 224 B | 08:04:19.209 / .408 `queued` | 08:04:19.337 · **0** | 08:12:42.165 | **NO — 0 bytes** | n/a | **NO** | 19:42:37 |
| 4 | tp1099-screen-apc | `aa546177…` 5 112 B | 08:05:16.318 / .507 `queued` | 08:05:16.427 · **0** | 08:12:42.226 | **NO — 0 bytes** | n/a | **NO** | 19:43:01 |

Inject ids: `223af96b-7b27-4844-9fc9-1e453d51825b`, `a8e21ae5-b5ad-4a19-86c4-41e1a3e63f02`,
`f079fe31-91f8-494a-839d-3f4e42a4f924`, `185f1cfc-dd6d-42d0-83db-5340005ed22b`. All four
`verified_sender_sid` = the claimed worker, `spoof_suspected: false`, `origin: trusted-local`.
All four `payload_bytes: 177` — the `--ref` **pointer**, not the body.

Worker wait, HOLD sent → GO received: tp1127 **11 h 39 m 56 s**, tp1125 **11 h 39 m 32 s**,
ah1117 **11 h 38 m 18 s**, tp1099 **11 h 37 m 45 s**.

### 3.2 Full incident timeline

| KST | UTC | Event | Source |
|---|---|---|---|
| 02:10:54 | 09-07T17:10:54.597Z | last daemon restart **before** the incident | ledger `daemon_restart_observed` |
| 08:00:10–08:00:59 | 23:00:10–23:00:59Z | four dispatches orchestrator→workers, all `success` | injects.jsonl |
| 08:01:54 | 23:01:54.465Z | orchestrator emits `AskUserQuestion` → modal up | transcript |
| 08:02:41–08:05:16 | 23:02:41–23:05:16Z | four HOLDs park, 0 bytes, depth 1→4 | ledger + daemon log |
| 08:03:01–08:06:12 | 23:03:01–23:06:12Z | **report-sweep copies all four into `state/dispatch/inbox/`** | reconciler.log |
| 08:12:41–08:12:42 | 23:12:41–23:12:42Z | park TTL expires, 4 ops flushed and discarded | ledger + daemon log |
| 08:12 – 18:41 | — | zero orchestrator turns; workers idle (`pty_quiet`) | transcript, daemon `[OBSERVE]` |
| 18:41:15 | 09-08T09:41:15.314Z | user answers the modal (10 h 39 m 21 s) | transcript |
| 18:42:29–18:50:50 | 09:42:29–09:50:50Z | tp1124 round-trip, all `success` — surface clear | injects.jsonl |
| 19:41:27 | 10:41:27.239Z | user: "지금 워커들 다 멈춰있는데? 확인해봐" | transcript |
| 19:41:55 | 10:41:55.891Z | orchestrator reads the four HOLDs **from `~/.telepty/shared`** | transcript |
| 19:42:36–19:43:01 | 10:42:36–10:43:01Z | GO re-dispatched to all four | injects.jsonl |
| 19:46:28–19:51:18 | 10:46:28–10:51:18Z | four REPORTs arrive, all `success` | injects.jsonl |
| 19:53:05 | 10:53:05.838Z | daemon restarts as 0.8.3 | daemon-state.json, ledger |
| 20:59:54 | 11:59:54.343Z | orchestrator session exits 0 after 261 629 s (3 d 0 h 40 m) | session-deaths.log |

---

## 4. Delivery classification (the four categories the dispatch asked for)

| Category | Count | Basis |
|---|---|---|
| **Not delivered** | **4 / 4** | `bytes_written: 0` recorded twice per message (park + drop) in a durable atomic-write ledger, corroborated by `delivery_result: "queued"` and by the absence of the bodies from the orchestrator transcript |
| Delivered but not submitted | 0 | no CR was sent for any of the four; no body ever reached a composer |
| Consumed but unanswered | 0 | transcript has zero entries in the 10 h 39 m window |
| Evidence unavailable | 0 | every leg is covered by a retained record |

---

## 5. Hypotheses tested

### 5.1 FALSIFIED — daemon restart / old bridge
Distinct `daemon_restart_observed` timestamps in the ledger place the surrounding restarts at
`2026-09-07T17:10:54.597Z` and `2026-09-08T10:53:05.882Z`. The park (23:02–23:05Z) and the flush
(23:12Z) both fall strictly inside one process lifetime. The daemon console confirms it independently:
the `Starting telepty daemon…` line preceding the parks is at log line 62 703 and the next is at line
63 086, with the parks at 62 751–62 766 and the flush at 62 772. **No restart occurred during the loss
window**; the 19:53 restart is a consequence of the 0.8.3 release, 11 h 40 m later.

### 5.2 FALSIFIED — "the orchestrator session was dead / stale"
`session-deaths.log` records a single `orchestrator` death at `2026-09-08T11:59:54.343Z` with
`duration=261629s` — a continuous session from ≈ 2026-09-05 20:26 KST. During the incident the session
was registered, owner-connected, and emitting `[IDLE] Session orchestrator idle for …` lines. It was
present and blocked, not absent.

### 5.3 CONFIRMED but NOT causal — the workers omitted `--submit`
Measured argv (worker transcripts, verbatim):

```
telepty inject --ref <plan.md> --from tp1127-tp1127-release-verify-wait orchestrator 'HOLD: tp1127 #1127 plan'
telepty inject --ref docs/specs/HOLD-tp1125-1125.md --from tp1125-tp1125-survivor-port orchestrator 'HOLD: tp1125 #1125 plan'
telepty inject --ref hold-1117.md --from ah1117-ah1117-phase3-instrument orchestrator 'HOLD: ah1117 #1117 plan'
```

No `--submit`, no `--submit-force` on any of them — which is why the daemon log contains **no**
`[SUBMIT] Session orchestrator` line for the window (`daemon.js:4195` logs that unconditionally on entry
to the submit route). Not causal: the body itself was parked and discarded, so a CR behind it would have
parked (`daemon.js:4215-4221`) and been flushed by the same `splice`. It is nevertheless a live protocol
deviation — without `--submit`, even a *successfully written* HOLD sits in the orchestrator's composer
without firing a turn.

### 5.4 NOT ESTABLISHED — the `[AUTH] Rejected unauthorized request from 127.0.0.1` line
One such line sits immediately before the first park. 56 exist across the whole log. No record ties it to
any of the four inject ids, and the ledger attributes all four parks to `claude_modal_ui`. Recorded as
unexplained background noise. Do not build a fix on it.

---

## 6. What the existing recovery path ALREADY supplies (measured, not assumed)

The dispatch frames "durable recovery of NEW inbound HOLD/REPORT refs through the existing
report-sweep/reconcile path" as the *desired* guard. It already exists, and it already worked on this
very incident.

`bin/session-reconciler.sh` (launchd `com.aigentry.reconciler`, `--loop`) → `src/reconciler/cli.ts:1268`
step 0b2 → `bin/dispatch-tracker.sh report-sweep` → `src/tracker/report-sweep.ts`. It scans
`$TELEPTY_SHARED_DIR` against a durable cursor (`state/dispatch/report-cursor.json`), atomically copies
every new ref into `state/dispatch/inbox/<date>-<track>-<sha>.md`, and advances the cursor only after a
successful write (`return 3` without advancing on failure, so the next tick re-emits).

Measured on 2026-09-08 (reconciler tick ≈ 63 s):

| Payload written (KST) | `NEW` line (UTC) | Capture latency | Inbox path |
|---|---|---|---|
| tp1127 08:02:41 | 23:03:01Z | **20 s** | `state/dispatch/inbox/2026-09-07-tp1127-f08331e9….md` |
| tp1125 08:03:04 | 23:04:05Z | **61 s** | `…/2026-09-07-tp1125-71c43d68….md` |
| ah1117 08:04:19 | 23:05:08Z | **49 s** | `…/2026-09-07-ah1117-c487ed45….md` |
| tp1099 08:05:16 | 23:06:12Z | **56 s** | `…/2026-09-07-tp1099-aa546177….md` |

All four landed on disk in the orchestrator's own repo **6–10 minutes before the daemon discarded them**,
and all four files are still there with the expected mtimes. **The capture leg is healthy and needs no
change.**

**The gap is the announce leg.** `report-sweep.ts` step 2 is literally `for (const line of lines)
stdout(line)`; the reconciler pipes that stdout into `log()`, which appends to `reconciler.log`. There is
no inject, no HITL gate, no alert, no state the orchestrator's turn loop reads. Grepping `bin/`, `src/`
and `docs/` of the orchestrator repo for `modal_park_timeout`, `inject_parked` and
`inject_delivery_dropped` returns matches **only inside a prior review document** — nothing consumes any
of the three signals the daemon emits when it parks or drops.

Two adjacent gaps measured in the same path:

- **Classification is heading-dependent.** `HEADER_RE = /^# (REPORT|HOLD|SPEC)\b/m`
  (`src/tracker/report-sweep.ts:165`) requires a markdown H1. tp1127's payload opens
  `HOLD: tp1127 #1127 plan — …` with no `# `, so it was filed as `NEW tp1127 REF` while the other three
  were filed `NEW … HOLD`. Same file, same inbox — but a consumer that keys on `kind` would miss it.
- **The orchestrator never looked at its own inbox.** At 19:41:55 it recovered by shelling
  `cd ~/.telepty/shared && ls -t *.md | head -12` — the raw daemon directory — not
  `state/dispatch/inbox/`, where clean, dated, track-named copies had been sitting for 11.5 hours.

---

## 7. Why nothing else caught it (each measured)

1. **The sender was told it succeeded.** `cli.js:3241` documents the choice: *"a PARKED delivery … `queued`
   answers 200 (#860), so it keeps the success path and exit 0."* The workers' transcripts show exactly
   what they saw — `✅ Context injected successfully into 'orchestrator'. (ref: ~/.telepty/shared/f08331e9….md)` /
   `inject_id: 223af96b-…` — and tp1127's next turn reads **"Phase 1 done — HOLD sent, waiting."** The
   200 response body *does* carry `bootstrap_queued: true`, `parked: "surface_modal"`, `reason` and a
   remediation `hint`; the CLI receives all four fields and prints none of them.
2. **Nobody polls an INBOUND inject's ledger record.** The dispatch registry
   (`state/dispatch/active.json`, 74 rows) keys on outbound dispatches: tp1127's row carries
   `transport.inject_id = e4ac03ee-…` (the 08:00:42 dispatch). `grep -c` for the four inbound ids across
   `active.json` returns **0**. The daemon wrote a correct, durable `inject_delivery_dropped` for each —
   and no reader on the orchestrator side is subscribed to inbound ids at all.
3. **The outbound watchdog's deadline was longer than the outage.** tp1127's row has
   `expected_report_by: 2026-09-08T10:59:36Z` (19:59:36 KST) against `dispatched_at 23:00:41Z` — a ≈ 12 h
   budget. The 11 h 39 m loss window closes *before* the tracker would have escalated.
4. **The daemon's absence signal was deliberately suppressed.** Throughout the window the daemon logged,
   repeatedly, `[OBSERVE] <worker>: pty_quiet NOT pushed to orchestrator — screen-derived absence while
   outcome_protocol=unavailable (gh#82 F …)`. Correct by that release's own rule — and it means the one
   automatic signal that four workers had gone quiet was withheld. Note it would have parked on the same
   modal anyway.
5. **The park TTL is per-poll, not per-op.** `scheduleModalParkDrain` returns early if
   `session.modalParkPoll` is already set, so `deadline` is fixed by the **first** park. tp1099's inject
   was parked at 08:05:16.427 and dropped at 08:12:42.226 — **445.8 s**, not 600 s. Later arrivals in a
   burst get a progressively shorter grace period than the constant advertises.

---

## 8. Reproduction / verification SPECIFICATION (SPEC FIRST — for a tester/builder role, not executed here)

### 8.1 Exact observable failure to reproduce

> Given a `claude`-command telepty session `S` whose surface is showing a modal
> (`detectSurfaceModal(...).blocked === true`), an inject to `S` is accepted with HTTP 200 and
> `delivery_result: "queued"`, writes zero bytes, and is **permanently discarded** `modalParkTtlMs()` ms
> after the *first* op in that park cycle — with no signal reaching the sender, the recipient, or any
> automated consumer.

**Minimal reproduction (must not touch the live orchestrator session):**

1. Spawn a disposable wrapped `claude` session `S_test` (not `orchestrator`).
2. Drive `S_test` to a modal — an `AskUserQuestion` or an ExitPlanMode approval — and leave it unanswered.
3. Set `TELEPTY_MODAL_PARK_TTL_MS=20000` for the run so the TTL is observable in 20 s rather than 600 s
   (`daemon.js:2836` reads it; blank/unset falls back to 600000).
4. `telepty inject --ref <file> --from probe S_test 'PROBE 1'`; then a second and third inject 3 s apart.
5. Wait past the TTL.

**Required observations (all four must hold, or the reproduction is not the incident):**

| # | Assertion | Where measured |
|---|---|---|
| R1 | CLI exits **0** and prints `✅ Context injected successfully` | process exit code + stdout |
| R2 | `injects.jsonl` line for that `inject_id` has `delivery_result: "queued"` | `~/.telepty/logs/injects.jsonl` |
| R3 | Ledger record has `inject_parked` / `reason: "claude_modal_ui"` / `bytes_written: 0`, then `inject_delivery_dropped` / `trigger: "surface_modal_park_timeout"` / `bytes_written: 0`, `tracking_state: "aborted"` | `~/.config/aigentry-telepty/tracked-injections.json` |
| R4 | The probe text **never** appears in `S_test`'s transcript | the session's `.jsonl` |
| R5 | The 3rd inject's `dropped_at − parked_at` is **strictly less than** the TTL, while the 1st's is ≈ TTL | ledger arithmetic — pins the §7.5 per-poll-deadline defect |

### 8.2 Negative controls (must FAIL to reproduce)

| Control | Expectation | Purpose |
|---|---|---|
| **N1 — no modal.** Same inject into `S_test` with a clear composer | `delivery_result: "success"`, no `inject_parked`, text visible on screen | proves the modal, not the inject path, is the discriminator |
| **N2 — modal answered inside the TTL.** Park an inject, dismiss the modal before the deadline | daemon logs `[MODAL] … surface cleared — draining N parked op(s)`; ledger shows delivery, **no** `inject_delivery_dropped`; text appears | proves the flush, not the park, is what loses the message |
| **N3 — daemon restart alone.** Restart the daemon with no modal present, then inject | delivers `success` | independently re-falsifies the restart hypothesis on a live system |
| **N4 — non-`claude` command.** Same scenario against a `codex` session | remedy is `hold` (30 s), not `park` (`MODAL_REMEDY_BY_CLI`) — different failure shape | bounds the defect to the `claude` park lane |
| **N5 — `--submit` present.** Repeat R with `--submit --submit-force` | daemon logs `[SUBMIT] Session S_test …`; both body and CR park and are flushed together | proves §5.3: `--submit` does not rescue a parked body |

### 8.3 Retained-evidence requirements (a run that does not retain these cannot be graded)

- `~/.telepty/logs/injects.jsonl` — copy the lines for every probe `inject_id`.
- `~/.config/aigentry-telepty/tracked-injections.json` — copy the **full record** (all observations, with
  `bytes_written` and ISO timestamps) for every probe `inject_id`, taken **after** the TTL.
- `~/Library/Logs/aigentry-orchestrator/telepty-daemon.log` — the `[MODAL]` / `[INJECT]` / `[SUBMIT]` /
  `[BUS-ROUTE]` lines for the run. **These lines carry no timestamps**; the run must record wall-clock
  markers around each step or the log is only orderable, not datable.
- `S_test`'s transcript `.jsonl` — to evidence R4 as an absence.
- The verbatim CLI stdout **and exit code** of every probe inject.
- `reconciler.log` lines for the same window if the sweep is in scope.

### 8.4 What result would validate a prospective correction

A candidate fix is validated only if, on the R scenario **unchanged**, all of:

- **V1 — no silent discard.** Either the message is eventually delivered, or a durable, *addressed*
  notice reaches a consumer that acts on it. `inject_delivery_dropped` sitting unread in the ledger does
  **not** satisfy V1: that record already exists today and is exactly what failed.
- **V2 — the sender learns.** The worker's `telepty inject` distinguishes "written" from "parked, may be
  dropped", in stdout and/or exit code. **Constraint:** `cli.js:3241` and `#840` deliberately keep
  exit 0 here so that callers do not retry and double-deliver, and `bin/dispatch.sh` gates on that exit
  code. A fix that flips this exit code must show it does not break every gated dispatch in the ecosystem.
- **V3 — no double delivery.** With the fix, an inject parked and later drained must appear on the
  recipient's surface **exactly once**. Assert on the recipient transcript, not on log lines. The
  redelivery/dedup path (`cli.js:2372`, "#720: drop stale-parked and consecutive-duplicate injects") is
  the existing art here and must be consulted before a second one is built.
- **V4 — restart durability.** Kill and restart the daemon while an inject is parked. Note the measured
  baseline: `restoreTrackedInjections` (`daemon.js:561`) restores ledger records and appends
  `daemon_restart_observed`, but the **`session.bootstrapQueue` itself is in-memory** — a restart
  therefore loses the parked body while leaving the ledger record alive. Any recovery must be keyed on
  something that survives a restart; the `~/.telepty/shared` ref + the sweep cursor already are.
- **V5 — recipient filtering.** Recovery must deliver a HOLD to the session it was addressed to
  (`to: "orchestrator"`, `transport_source: "<worker>"` are both in the audit and the ledger). The
  `~/.telepty/shared` payload files carry **no addressing metadata** — filename is the content sha, and
  `ref_path` is `null` in every audit line measured (see §8.5). Recipient must come from the ledger or
  the audit, never from the shared file alone.
- **V6 — the negative controls still hold.** N1–N5 must behave as specified **after** the fix; in
  particular N1 must not acquire new latency or a new notification.
- **V7 — no regression in the sweep.** `state/dispatch/report-cursor.json` must still advance
  monotonically and no ref may be double-filed; the capture latencies of §6 (20–61 s) must not regress.

### 8.5 A measured limitation any fix must design around

`ref_path` is `null` in **every** `injects.jsonl` line examined — the four incident lines, the successful
18:43–20:17 lines, and the 21:18:54 dispatch that carried this very task. The `--ref` pointer body is
177 bytes and its `payload_sha256` is the sha of the *pointer text*, **not** of the shared file (whose
sha256 is its filename, verified: `shasum -a 256` of each of the four returns its own basename). So the
signed audit log **cannot be joined to the retained payload except by timestamp adjacency**. Historical
correlation beyond ±2 s is therefore not reliably available, and a fix that wants to reconcile "which
audit line is which shared file" must either populate `ref_path` or carry the linkage elsewhere.

---

## 9. Narrow requirement for the next architect/coder

Stated as constraints, not as a design. **No implementation is authorized by this report.**

1. **Do not build a capture subsystem.** `report-sweep` already captures inbound refs durably, with a
   cursor, atomically, within ~60 s (§6, measured on these four messages). Building a second capture path
   would duplicate a working one.
2. **The missing leg is announce.** Today the sweep's only output is a `reconciler.log` line. The
   requirement is that a NEW inbound HOLD/REPORT ref becomes something the orchestrator's turn loop
   actually consumes.
3. **The announcement cannot rely on `telepty inject` alone.** Measured: on 2026-09-08 the orchestrator
   was itself the modal-blocked session. A notification injected at 08:03 would have parked behind the
   same modal and been flushed by the same `splice`. Any design whose only delivery mechanism is an inject
   into the blocked session reproduces the incident.
4. **Duplicate notification is the primary risk.** The four payloads were captured to the inbox *and*
   recovered manually 11.5 h later; a naive announce would have raised them twice. Dedup must key on the
   ref sha (`cursor.seen`, already present) **and** on whether the orchestrator has acted, not on a
   one-way "already notified" bit — the failure mode `deliveredAbsenceIdentities` (`daemon.js:844`) exists
   to prevent, documented there as ~70 spurious orchestrator turns in one night.
5. **Restart/cursor durability.** `report-cursor.json` survives restarts; `session.bootstrapQueue` does
   not. Build on the former.
6. **Recipient filtering is not derivable from the shared file.** See §8.5 — addressing lives in the
   ledger and the audit, not in `~/.telepty/shared`.
7. **Missing-history limits.** The ledger caps observations at `MAX_OBSERVATIONS_PER_RECORD = 50`
   (`src/session-store/persistence.js:153`) and the sweep cursor's `seen` map is pruned to the overlap
   window. Neither is a long-term archive; a design that assumes indefinite history will fail on a busy day.
8. **Two small, independent, verifiable defects surfaced here.** Neither is authorized for change now;
   both should carry their own task: (a) the per-poll rather than per-op park deadline (§7.5 — tp1099 got
   445.8 s of a documented 600 s); (b) `report-sweep`'s H1-dependent classification (§6 — tp1127's HOLD
   filed as `REF`).
9. **The defect is present in the version running right now.** `git diff a79aca9 HEAD -- daemon.js` is 4
   lines and none touch the park path. This is not a historical curiosity closed by 0.8.3.

---

## 10. Notification-delivery note (Rule 7)

The HOLD notification for this phase is sent with `telepty inject --ref --submit --submit-force` per the
dispatch protocol. Should that inject be parked or dropped — the very failure this report documents —
this committed file is the authoritative record, and the delivery error will be appended here at the next
boundary. Enqueue will not be treated as delivery.

---

## 11. Evidence index (verbatim commands, all read-only)

```bash
# audit — the four `queued` lines and the surrounding successes
grep -E '"ts":"2026-09-0(7T2[2-3]|8T0[0-2])' ~/.telepty/logs/injects.jsonl

# ledger — park + drop with measured bytes_written
python3 -c "import json;d=json.load(open('$HOME/.config/aigentry-telepty/tracked-injections.json'));\
print(json.dumps(d['injections']['223af96b-7b27-4844-9fc9-1e453d51825b'],indent=1))"

# daemon console — the park burst and the flush
grep -n '223af96b\|a8e21ae5\|f079fe31\|185f1cfc' ~/Library/Logs/aigentry-orchestrator/telepty-daemon.log
sed -n '62740,62775p'  ~/Library/Logs/aigentry-orchestrator/telepty-daemon.log

# report-sweep capture
grep -n '2026-09-07T23:0' ~/Library/Logs/aigentry-orchestrator/reconciler.log

# retained payloads, sha256 == filename
shasum -a 256 ~/.telepty/shared/{f08331e9*,71c43d68*,c487ed45*,aa546177*}.md

# inbox copies
ls -laT ~/projects/aigentry-orchestrator/state/dispatch/inbox/ | grep 2026-09-07

# every daemon restart, dated from the ledger
python3 -c "import json,collections;d=json.load(open('$HOME/.config/aigentry-telepty/tracked-injections.json'));\
c=collections.Counter(o['at'] for r in d['injections'].values() for o in r.get('observations',[]) \
if o.get('kind')=='daemon_restart_observed');print(*sorted(c),sep='\n')"

# code paths (aigentry-telepty)
daemon.js:818   deliveryAuditResult      — `queued` means bootstrap_queue, 0 bytes
daemon.js:2692  isSurfaceBlockedByModal  — the detector
daemon.js:2719  MODAL_REMEDY_BY_CLI      — claude ⇒ park
daemon.js:2835  MODAL_PARK_TTL_DEFAULT_MS = 600000
daemon.js:2848  flushModalParkQueue      — splice(), discard, abortTrackedInjection
daemon.js:2915  scheduleModalParkDrain   — ONE deadline per poll cycle
daemon.js:3020  deliverInjectionToSession — parkTrackedInjection('claude_modal_ui')
daemon.js:4195  the unconditional [SUBMIT] entry log (absent ⇒ no CR was sent)
cli.js:3241     the deliberate exit-0-on-`queued`
src/prompt-symbol-registry.js:98,167  claude_modal_ui

# code paths (aigentry-orchestrator)
src/reconciler/cli.ts:1268   step 0b2 — invokes report-sweep
src/tracker/report-sweep.ts  the capture; step 2 "announce" is stdout() only
src/tracker/report-sweep.ts:165  HEADER_RE — H1-dependent classification
```
