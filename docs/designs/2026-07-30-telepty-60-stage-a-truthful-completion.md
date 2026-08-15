# telepty #60 — truthful completion signalling

**Status:** Phase 1 design only; implementation is not authorized.  
**Targets:** 0.8.0 = Stage A truth cutover plus security issue #815; 0.9.0 = Stage B, blocked on #816 and #817.  
**Decision:** replace inferred task outcomes with measured observations and extract task-outcome authority to the orchestrator. Version 0.8.0 emits no terminal task outcome; completion remains explicitly unknown.  
**Revision:** Round 8 preserves all closed repairs, requires accepted non-ambiguous submit evidence for positive consumption, gives no-new-delivery dedup a distinct exit, and pins the full consumer vocabulary.

## 1. Correct framing

This is not a detector-tuning problem. It is a type-confusion problem:

1. **Transport/delivery** — bytes were handed to a session.
2. **Activity** — the PTY emitted bytes, became quiet, painted a prompt-like surface, or matched a waiting/error pattern.
3. **Inject consumption** — evidence suggests the injected bytes started a turn.
4. **Task outcome** — the assigned task was explicitly reported complete, blocked, or failed.

The current daemon lets facts from the first three domains assert the fourth:

- `sawWorkingAfterInject` is recorded on entry to `working|thinking` and is included in submit evidence (`daemon.js:106-116`, `daemon.js:413-418`).
- elapsed time alone is one arm of `confirmed` (`daemon.js:707-715`).
- submit acceptance/consumption is treated as strong completion confirmation (`daemon.js:675-688`).
- the bridge's unqualified `ready` frame invokes auto-report (`cli.js:2075-2084`, `src/transport/websocket.js:233-240`).
- any reverse-routed payload falls back to `report_complete`, including a clarifying question (`daemon.js:450-459`, `daemon.js:4047-4077`). The changelog explicitly records the accepted mislabel (`CHANGELOG.md:122-125`).

The correct boundary is:

> PTY-derived signals may describe PTY activity only. Task outcome may be described only as an explicit, authenticated, correlated report from the assigned session.

This also resolves the repository-boundary conflict instead of widening it. The intended boundary says telepty does not know CLI state, inject processing, output meaning, or cross-session routing (`BOUNDARY.md:12-20`, `BOUNDARY.md:24-32`). The file records report enforcement as an unresolved implementation divergence and says the constitutional choice belongs to the orchestrator (`BOUNDARY.md:34-56`). The accepted boundary is extraction: telepty emits transport/authentication measurements; the orchestrator owns dispatch outcome.

### Why the proposed additive Stage 1 is insufficient

The suggested order correctly notices that tightening `confirmed` routes traffic into existing silence doors. But “add a truthful event without changing assertions” cannot meet the owner's requirement:

- the legacy `TASK_COMPLETE` text would still lie;
- `TASK_IDLE_UNCONFIRMED` asserts that inject consumption may not have happened even where consumption was measured (`daemon.js:772-785`, `daemon.js:817-824`);
- externally emitting `idle` still invites the exact forbidden “turn over” interpretation (`session-state.js:390-419`, `daemon.js:2587-2593`);
- the reverse-report fallback still calls any outbound message completion (`daemon.js:457-459`).

Therefore the first safe release must atomically do both:

1. make every tracked path emit or persist an explicit “no completion fact” result; and
2. remove terminal semantics from every correlate.

It must **not** add a new fact detector in that release.

## 2. Truth model and event contract

### 2.1 Facts the system actually measures

| Measurement | What may be said | What may not be said |
|---|---|---|
| inject handler success | “inject written/queued by strategy X” | consumed, started, complete |
| `idle|waiting → working|thinking` | “busy-like activity observed after submit” | this inject completed |
| no output for N ms | “PTY quiet for N ms” | idle, done |
| prompt/composer match | “prompt/composer-like bytes observed by detector D” | turn ended |
| repeated error text | “repeated error-pattern F observed” | task failed or inject was not processed |
| child exit | “session process exited with status S” | task completed |
| verified correlated outcome report | “assigned session reported outcome O for dispatch D” | objective correctness beyond the report |
| PTY output chunk | “PTY output advanced by B bytes” | worker is doing the assigned task, inject consumed |
| busy-indicator pattern match | “busy-indicator pattern D matched bytes B” | the process is busy or this inject started |
| input-request pattern match | “input-request pattern D matched bytes B” | the task is blocked or requires a human |
| lifecycle control call | “start/restart/death lifecycle mark M was received” | process state beyond the fact carried by M |
| caller-supplied state mark | “caller C requested state mark M” | PTY quiet, prompt present, ready, or task outcome |
| continuous internal `thinking` classification for N ms | “busy-like classification timed out after N ms” | error text/pattern observed, task failed, process still busy |
| launcher watermark | “submit accepted; PTY output advanced after submit; elapsed N ms” | injected bytes consumed, turn started, output attributable to this dispatch |
| submit-gate body removal or output echo | “composer body removal / matching echo observed by detector D” | turn started or task completed |

The transport limitation is already documented: `inject_written` confirms an OS/PTY handoff, not process consumption (`BOUNDARY.md:14-16`, `BOUNDARY.md:24-26`).

### 2.2 New discriminated outputs

The `task_completion_unknown` contract below is the 0.8.0 contract.

Telepty emits only these task-adjacent measurements:

```json
{
  "type": "task_completion_unknown",
  "schema_version": 2,
  "session_id": "worker-1",
  "inject_id": "transport-uuid",
  "completion_fact": null,
  "terminal": false,
  "observation": {
    "kind": "pty_quiet",
    "trigger": "silence_timeout",
    "elapsed_ms": 5000
  },
  "consumption": {
    "status": "observed",
    "basis": "fresh_busy_transition"
  },
  "capability": {
    "turn_boundary": "unavailable",
    "outcome_protocol": "unavailable",
    "outcome_protocol_reason": "stage_b_deferred_to_0.9.0"
  }
}
```

The source-facing text is equally literal:

```text
TASK_COMPLETION_UNKNOWN: worker-1 — no completion fact observed; pty_quiet=5.0s; consumption=observed; outcome protocol unavailable
```

The following report measurement is a **0.9.0 target**, not a 0.8.0 output. It remains blocked until #816 supplies a private capability-delivery/report channel and #817 supplies cross-machine sender identity:

```json
{
  "type": "task_outcome_report_observed",
  "schema_version": 2,
  "verified_sender": {
    "sid": "worker-1",
    "session_epoch": "epoch-random-1",
    "credential_generation": 1
  },
  "claimed_sender_sid": "worker-1",
  "target_sid": "orchestrator",
  "transport_inject_id": "uuid",
  "assignment_capability_tag": "sha256:non-secret-audit-tag",
  "reported_outcome": "complete"
}
```

In 0.9.0, the orchestrator alone may emit:

```json
{
  "type": "dispatch_outcome_reported",
  "dispatch_id": "dispatch-uuid",
  "assigned_sid": "worker-1",
  "assigned_session_epoch": "epoch-random-1",
  "outcome": "complete",
  "basis": {
    "kind": "authenticated_correlated_outcome_report",
    "transport_inject_id": "uuid",
    "assignment_capability_tag": "sha256:non-secret-audit-tag"
  }
}
```

Use `REPORTED`, not bare `COMPLETE`, in consumer-facing text:

```text
TASK_REPORTED_COMPLETE: worker-1 reported complete for dispatch dispatch-uuid
```

This says exactly what was measured. It does not claim that telepty independently verified the work.

### 2.3 External activity vocabulary

Keep the eight internal FSM values in the first patch because submit/readiness code branches on them (`src/submit-gate.js:21-46`, `src/submit-gate.js:498-508`). Do not expose those values unchanged.

The external name is selected from a normalized measurement cause, never from the destination state alone. The classifier input is `(destination, normalized_cause, required_evidence)`:

| Current entrance | Required normalized cause/evidence | Externally emitted observation |
|---|---|---|
| constructor / `markStarting` | `lifecycle_starting` | `session_start_phase_observed` |
| raw OSC 133 A/B in `feed` | `osc_133_a_or_b_received`, marker kind and timestamp | `osc_133_a_or_b_observed` |
| `_tick`, quiet after recent OSC 133 | `quiet_after_recent_osc_133_a_or_b`, `silence_ms` | `pty_quiet_after_osc_133_a_or_b_observed` |
| `_tick`, quiet plus prompt regex | `prompt_suffix_after_quiet`, detector and `silence_ms` | `prompt_suffix_after_quiet_observed` |
| `_tick`, silence without prompt/OSC | `silence_timeout`, `silence_ms` | `pty_quiet` |
| `markIdle` or another caller mark | `manual_state_mark`, caller and caller reason | `manual_state_mark_observed` |
| ordinary unmatched output | `output_received`, byte delta/timestamp | `output_observed` |
| thinking-pattern match | `busy_indicator_pattern`, detector/matched basis | `busy_indicator_pattern_observed` |
| waiting-pattern match | `input_request_pattern`, detector/matched basis | `input_request_pattern_observed` |
| repeated-error entrance | `repeated_error_pattern`, fingerprint/count/window | `repeated_error_pattern_observed` |
| thinking-timeout entrance | `thinking_timeout`, `thinking_duration_ms` only | `thinking_classification_timeout_observed` |
| `markRestarting` | `lifecycle_restarting` | `session_restart_mark_observed` |
| actual child-exit `markDead` | `process_exit`, exit code/signal | `session_process_exited` |
| #815 displaced-owner/death event | `owner_epoch_replaced` / `owner_process_exited`, displaced epoch | `owner_replaced_observed` / `session_process_exited` |

Stage A normalizes the currently overloaded trigger strings at their producers: raw-OSC and quiet-after-OSC no longer share `osc_133_prompt`; start/restart/death no longer share `lifecycle`; and `markIdle` cannot let caller detail overwrite the normalized cause. An unknown destination/cause/evidence combination returns and persists `unmapped_transition_cause` with the raw destination and trigger, `completion_fact:null`, and no stronger observation name. It never falls back to a state-name mapping.

Include only fields required by the selected row, plus `last_output_at` and the existing confidence where measured. Confidence qualifies the classifier; it never manufactures missing evidence or qualifies completion.

## 3. Staged design

### Stage A — atomic truth cutover

This is the safety release. It changes semantics and must land with consumer updates.

1. **Durably record absence before delivery.** The orchestrator must complete the durable create transaction in the subsection below before invoking telepty. That record is the authoritative no-silence fact. Telepty then commits its versioned transport-observation record before handing bytes to the target and emits `task_completion_unknown/tracking_started`. Neither write is best-effort.
2. **Make every observation producer total, not only `fireAutoReport`.** One pure observation decision function covers the transition handler, ready callback and dwell timer, settle/rearm callbacks, CPU/output rechecks, consumption branch, session death, authenticated owner displacement from #815, supersession, cancellation, and restart restoration. It classifies the measured cause under §2.3, never only the destination state. Every eligible invocation returns and persists one of `observation_emitted`, `observation_duplicate`, `unmapped_transition_cause`, `tracking_superseded`, `tracking_unavailable`, or another named nonterminal result. The current `onTransition` guard `if (pendingReport.idleNotified) return` is explicitly in scope (`daemon.js:119-138`), as are the bare timer/consumption returns inside `fireAutoReport` (`daemon.js:650-661`, `daemon.js:725-785`).
3. **Downgrade all auto outcomes.** `ready-signal`, `real-idle`, `silence-timeout`, elapsed thresholds, submit flags, CPU, prompt glyphs, OSC 133 A/B, and terminal error patterns can emit only `task_completion_unknown`.
4. **Cover absorbing states without laundering their causes.** A waiting-pattern entrance emits `input_request_pattern_observed`; repeated-error emits `repeated_error_pattern_observed` with fingerprint/count/window; thinking-timeout emits `thinking_classification_timeout_observed` with duration and no error-pattern fields; actual death emits `session_process_exited`. All carry `completion_fact:null`. The daemon currently handles only working/thinking, idle, and dead, with no waiting/error report branch (`daemon.js:105-159`), while `session-state.js:347-386` shows the two semantically different error entrances.
5. **Replace the `pendingReports`/`idleNotified` authority shape.** Persist a versioned `tracked_injections` observation ledger containing `inject_id`, target session epoch if known, transport source, creation time, last observation, observation sequence, and capability state. It contains no task outcome. Observation idempotency is keyed by observation identity, not a one-way `idleNotified` bit; duplicate suppression cannot become an authority gate for the future Stage-B report path.
6. **Stop report laundering and remove the outer silence gate.** In 0.8.0 an ordinary reverse-routed inject is always an ordinary message; remove the fallback and do not parse any text as a terminal report. There is no automatic terminal producer or report-control endpoint in this release. The 0.9.0 report path, when #816/#817 exist, must remain independent of `pendingReports`, `tracked_injections`, PTY state, and reverse-route matching. The current nested `if (from) → if (senderPending) → if (source matches)` gate is not retained (`daemon.js:4047-4093`).
7. **Qualify ready frames.** The bridge sends `ready_kind`, `detector`, and `cli_key`. Known AI CLI registry-tail matches are `composer_surface_observed`; generic current-frame matches are `prompt_suffix_observed`. Both remain delivery-readiness hints only. Today the frame is only `{type:"ready"}` (`cli.js:2075-2084`).
8. **Rename external state.** Replace externally serialized `autoState.state:"idle"` and `session_auto_state` values with the measurement vocabulary in §2.3 (`daemon.js:101-103`, `daemon.js:2544-2593`, `daemon.js:3021-3039`).
9. **Remove every orchestrator inference path atomically.** The tracker may persist screen, PTY, git, error, disconnect, and cleanup observations, but none may change `outcome.state` or `outcome.reported_value`, or stop unknown-outcome polling. Replace `tracker_class:"done"` with `prompt_observed`; replace `AUTO_REPORT/auto_reported` with a nonterminal review snapshot; remove 404/empty-schema fallthrough; and make cleanup update lifecycle only. The current inference chain crosses `session-probe.py:130-151`, `dispatch-tracker.sh:299-333`, `dispatch-tracker.sh:490-555`, and `session-cleanup.sh:237-252`.
10. **Separate consumption provenance and require accepted submit.** `consumption.status:"observed"` is permitted only when all of these hold: the fresh edge is post-submit `idle|waiting → working|thinking`; its timestamp is at or after submit start; and `submitConfirm.accepted === true` with `submitConfirm.ambiguous === false`. Record that provenance explicitly as `injectConsumedVia:"fresh_busy_transition"` together with the confirmation reason/timestamp and transition origin/destination/timestamp. A missing, ambiguous, force-only, or positively rejected confirmation cannot set `injectConsumedAt`, even if unrelated output produces the edge. In the evidence resolver, `accepted === false` is checked before any durable-consumption field, so a stale/legacy `injectConsumedAt` cannot override the positive rejection; emit `submit_rejection_observed` and consumption `not_established`. `launcher_watermark` never sets `injectConsumedAt` and never flows through `consumed_recorded`; it emits `submit_accepted_and_output_advanced` with acceptance basis, ring-byte delta, and elapsed time, while consumption remains `not_established`. Composer body removal and output echo similarly retain literal `submit_body_removed_observed` / `inject_echo_observed` names unless the full accepted fresh-edge predicate independently holds.

If a second tracked dispatch supersedes the session's active observation pointer, retain the old `inject_id` record and append `tracking_superseded` before selecting the new one. The existing code only logs and overwrites a SID-keyed entry (`daemon.js:4095-4112`). The orchestrator ledger remains keyed by `dispatch_id`, so supersession never erases outcome history.

#### Stage A authoritative orchestrator-ledger contract

The current order is wrong: `dispatch.sh` performs `do_inject` at line 620 and only then calls the best-effort tracker hooks at lines 634–635; both hooks swallow absence/failure (`dispatch.sh:351-377`). Version 0.8.0 reverses that contract.

1. **Stable lock and schema validation.** All registry operations acquire an exclusive lock on a stable sibling lockfile, not the `active.json` inode that an atomic rename replaces. Under the lock, read a versioned envelope such as `{schema_version:2,generation,dispatches:[...]}` and validate its complete shape. Missing storage may be initialized durably; malformed JSON, wrong schema, duplicate `dispatch_id`, or invalid field type is `registry_corrupt`, never `entries=[]`.
2. **Durable begin immediately before inject.** Generate `dispatch_id` and the existing `(assigned sid, ref_hash)` dedup key. Run the transactional dedup check before spawn/readiness/preparation, without creating a no-match record or sidecar; every failure in those pre-call steps returns a named nonzero error. Immediately before `do_inject`, run atomic `begin-delivery`, which rechecks dedup under the lock and, only for a new/retryable attempt, creates `outcome.state:"unknown"`, `outcome.reported_value:null`, `lifecycle.state:"delivery_attempt_started"`, and observation `dispatch_tracking_started`. Write a temp file in the same directory, flush and `fsync` the temp file, atomically rename it over `active.json`, and `fsync` the containing directory. Only its successful `proceed` result authorizes `do_inject`.
3. **Fail the dispatch, not the record.** Missing registry helper, missing runtime needed by that helper, lock failure/timeout, disk-full, permission failure, validation failure, temp-write failure, `fsync` failure, or rename failure aborts before telepty is called. The caller receives a synchronous `DISPATCH_NOT_RECORDED`/specific registry error. There is no accepted dispatch and no delivered task to become silent.
4. **Bracket the delivery call durably.** Task gate, spawn/readiness, target-resolution, and temporary-ref preparation all occur before `begin-delivery`; their failure is an explicit non-delivery error and leaves no dedup mark or accepted dispatch record. After `begin-delivery`, call telepty without another fallible preparation step. A typed proof that telepty never handed off bytes may record `not_delivered`; generic nonzero return, caller crash, or failure of the post-call transaction becomes `delivery_state_unknown`, because bytes may have landed. A successful transport response records `transport_write_observed`, not consumption. The already-durable unknown outcome survives every post-begin arm, and no ambiguous arm automatically re-injects.
5. **Corruption is fail-closed and preserved.** A reader or writer encountering corrupt state returns `registry_unavailable/registry_corrupt`, preserves the bytes for diagnosis, emits a health alert outside the corrupt file, and performs no delivery, pruning, cleanup, status restore, or empty-file replacement. Recovery requires an explicit repair/migration command.
6. **No in-place truncate writers.** The current `r+ → truncate → json.dump` paths are forbidden because a crash can leave valid state empty/partial. Every writer uses the same transactional registry component.

The telepty observation ledger remains independently durable because it describes transport facts, but it is not a substitute for this write-before-delivery authority record.

#### Stage A deduplication contract

The existing sidecar gate is another pre-delivery authority: `dedup_check_and_mark` writes `$HOME/.aigentry/dispatch-helper/<sid>` before readiness/delivery and line 609 exits 0 before any tracker call. Version 0.8.0 removes that sidecar from decision authority and folds deduplication into the same locked registry transaction.

1. `check-dedup(sid, ref_hash)` validates the registry and searches the durable dedup key while holding the stable sibling lock. A no-match result is read-only and permits spawn/readiness/preparation. `begin-delivery(sid, ref_hash, dispatch_id)` repeats the same check atomically to close the concurrency window and creates the unknown `delivery_attempt_started` record only on `proceed`. Neither writes a sidecar.
2. If no matching record exists, or every matching record has a typed `not_delivered` transport result, `begin-delivery` creates the new unknown attempt. A pre-call abort before this transaction needs no clearing operation because no cache or dispatch record has been created; it returns nonzero and an identical retry performs the checks again.
3. If a matching record has `transport_write_observed`, append `dedup_suppressed` to that existing record and emit a discriminated `DISPATCH_DEDUPLICATED` response containing its `dispatch_id`, `new_delivery:false`, `prior_transport:"write_observed"`, `completion_fact:null`, and outcome `unknown`. It exits with distinct non-success code 8 (`DEDUPLICATED_NO_NEW_DELIVERY`), never 0: exit 0 is reserved for a new telepty transport success whose `transport_write_observed` registry commit also succeeded. A post-call registry failure is delivery-unknown/exit 7. Exit-code-only callers can therefore never mistake suppression or uncertain bookkeeping for re-dispatch.
4. If a matching record is `delivery_attempt_started` or `delivery_state_unknown`, append `dedup_retry_held` and emit `DISPATCH_RETRY_HELD` with the existing `dispatch_id`, `new_delivery:false`, `prior_transport:"unknown"`, and `completion_fact:null`; use distinct non-success exit 7 (`DELIVERY_UNKNOWN_RETRY_HELD`). The operator must review or supply a future transport idempotency key before retrying.
5. If appending either dedup observation fails, return the registry error and do not call telepty. A dedup decision is never a print-only success.
6. No code may perform fallible preparation between a successful `begin-delivery` commit and `do_inject`. A crash in that deliberately narrow interval is conservatively `delivery_state_unknown` and receives the explicit held behavior in item 4, not automatic replay.
7. During cutover, archive the legacy sidecar directory after dispatch is fenced. A sidecar without a matching v2 record has no meaning and cannot suppress a dispatch. After activation, the sidecar is neither read nor written.

Thus every deduped invocation points at an existing durable unknown record and emits why no new transport call occurred. Every new invocation either fails explicitly before acceptance or atomically becomes a durable `delivery_attempt_started` unknown immediately before transport. There is no successful no-record/no-telepty exit.

Both automatic re-dispatch callers must branch on the result rather than treating every nonzero alike. Exit 0 alone authorizes `re_dispatch_count += 1`, lifecycle `re_dispatched`, and a new deadline. Exit 8 appends `redispatch_suppressed_duplicate` and leaves the counter/deadline unchanged; exit 7 appends `redispatch_held_delivery_unknown` and likewise leaves them unchanged. Other nonzero codes remain actual re-dispatch failures. This applies to `dispatch-tracker.sh:386-396` and `session-reconciler.sh:295-297`; stdout may remain redirected because the exit contract is sufficient.

#### Stage A restart contract

`pendingReports` is process memory (`daemon.js:384`), while the current persistence writer serializes sessions only (`src/session-store/persistence.js:11-54`). Schema v2 therefore cannot use `pendingReports` as either the absence store or the report gate.

- Telepty persists `tracked_injections` atomically with a schema version before acknowledging a tracked inject. Restore happens before HTTP/WS readiness. A persistence failure rejects tracked delivery with a named `tracking_persistence_failed` result; it does not deliver and then forget.
- `GET /api/inject-observations/:inject_id` always returns a discriminated schema-v2 body. A known record returns its last observation. An absent/corrupt/migration-missing record returns HTTP 200 with `completion_fact:null`, `tracking_state:"unavailable"`, and a reason such as `not_observed_by_daemon_epoch` or `observation_store_unavailable`; schema v2 never uses 404 as a task-state signal.
- The orchestrator's durable dispatch record is the primary no-silence guarantee. Telepty's ledger is transport observation history, not a second dispatch authority.
- A daemon restart appends `daemon_restart_observed` to restored records. A missing restored record cannot settle, delete, or suspend a dispatch.
- Version 0.8.0 has no report control request. In the 0.9.0 design, a report request after restart must not consult this ledger; #816/#817 must provide the missing capability and identity facts before the orchestrator can correlate it against its own durable record.

The orchestrator record is no longer one overloaded `status` string:

```json
{
  "dispatch_id": "internal-uuid",
  "assigned": { "sid": "worker-1", "session_epoch": null },
  "dedup": {
    "key": "sha256-of-sid-and-ref-hash",
    "ref_hash": "sha256-of-ref-bytes"
  },
  "outcome": {
    "state": "unknown",
    "reported_value": null,
    "basis": null
  },
  "lifecycle": { "state": "delivery_attempt_started" },
  "last_observation": {
    "kind": "dispatch_tracking_started",
    "terminal": false
  }
}
```

Stage A may populate `session_epoch:null` with a precise capability reason while a legacy worker has not established a #815 epoch. Version 0.8.0 never transitions `outcome.state` away from `"unknown"` and never sets `outcome.reported_value`. Prompt detection, git changes, disconnect, error, timeout, HITL, cleanup, owner displacement, and daemon restart update only observations, gates, or lifecycle. The word `reported` is reserved for the future 0.9.0 validator; there is no `auto_reported` state.

#### Stage A registry writer inventory and structural enforcement

A repository-wide `rg` over production code finds three direct `active.json` writers and four indirect/schema consumers:

| Component | Current access | 0.8.0 disposition |
|---|---|---|
| `bin/dispatch-tracker.sh` | initializes the file; `_mutate_state`, `cmd_append`, `_set_status`, redispatch and `mark-reported` write it (`:44`, `:121-184`, `:241-249`, `:290-355`, `:388-398`) | all writes become typed calls to the transactional registry component; no outcome mutation command exists |
| `bin/session-reconciler.sh` | `registry_update_status` and `registry_note_redispatch` write `entry["status"]` in place (`:170-218`) | append lifecycle/observation operations only through the registry component |
| `bin/hitl.sh` | `registry_set_status` and `registry_clear_redispatch` open `active.json` with `r+` and restore runtime status strings (`:97-159`, calls at `:244`, `:339`, `:363`) | write a separate gate axis such as `gate.state:"awaiting_user"`; approval restores the gate axis, never outcome |
| `bin/dispatch.sh` | indirectly writes through tracker hooks, currently after delivery and failure-swallowing (`:351-377`, `:620-643`) | calls mandatory registry `create` before inject, then typed delivery observation |
| `bin/inject-handler.sh` | textual `report` handling calls tracker `mark-reported` and swallows failure (`:93-108`) | remove the 0.8.0 outcome hook; a parsed legacy REPORT is an ordinary/nonterminal message or explicit `outcome_protocol_unavailable`, never a registry outcome mutation |
| `bin/session-cleanup.sh` | indirectly calls tracker `mark-reported` after session disappearance (`:237-252`) | records lifecycle `cleaned`; cannot touch outcome |
| `bin/dispatch-cleanup-scheduler.sh` | reads `ACTIVE_JSON` directly for `keep_alive` (`:44`, `:68-79`) | reads through the schema-validating registry component and fails closed on unavailable/corrupt state |

`session-reconciler.sh`, `dispatch-tracker.sh`, and `hitl.sh` also contain direct readers; they migrate to the same schema-validating read API. Test fixtures that seed `active.json` migrate to the versioned envelope but are not production writers.

The enforcement is tied to fields that the schema guarantees exist:

1. A schema contract test loads every created record and requires JSON pointers `/dispatches/*/outcome/state` and `/dispatches/*/outcome/reported_value`; it additionally requires `/dispatches/*/lifecycle/state`, `/dispatches/*/dedup/key`, and `/dispatches/*/dedup/ref_hash` so the pre-delivery/dedup proof is data-bound too.
2. A source invariant rejects any production open-for-write, truncate, rename-over, or direct JSON mutation of `active.json` outside the one registry component.
3. A second invariant rejects assignments to `outcome.state` or `outcome.reported_value` outside that component. Inside the 0.8.0 component, the only permitted creation values are exactly `"unknown"` and `null`; there is no `record-outcome`, `mark-reported`, or arbitrary-field mutation operation.
4. Typed operations expose only `check-dedup`, `begin-delivery`, `observe`, `set-lifecycle`, `set-gate`, `set-transport-result`, and schema-validating reads. Dedup is rechecked atomically by `begin-delivery`; none can mutate outcome. A source invariant rejects reads/writes of the retired dispatch-helper dedup marks outside the one cutover archival command. Unknown operation/field names fail closed.

This makes A1's 0.8.0 single-writer claim non-vacuous: the exact outcome fields are required to exist, their only writer is enumerated, and that writer has no terminal transition.

#### Stage A consumption of #815 owner lifecycle

Issue #815 owns the WebSocket-claim fix; issue #60 does not redesign it. Stage A consumes the honest lifecycle facts #815 promises. This matters because the current `?owner=1` path uses only the URL SID, unconditionally replaces `ownerWs`, gives the claimant a fresh owner token, and calls `markSessionConnected` (`src/transport/websocket.js:46-52`, `src/transport/websocket.js:116-159`). The displaced real bridge treats close 4001 as terminal and exits (`cli.js:529-535`, `cli.js:1965-1973`) without necessarily driving the session-state `markDead` branch.

The required Stage-A consumption contract is:

1. On #815's authenticated `owner_replaced` fact, telepty first appends `owner_replaced_observed` to every tracked inject assigned to the displaced session epoch, then exposes the persisted observation through the endpoint/bus. The orchestrator's bus-or-poll consumer commits the same observation to the dispatch record before acknowledging it. A lost bus delivery is recovered by polling the durable telepty sequence. It carries `completion_fact:null`; owner replacement is not task completion or failure.
2. Mark the old assignment's authentication capability unavailable immediately with reason `assigned_owner_epoch_replaced`. A replacement connection cannot authenticate a dispatch assigned to the displaced epoch.
3. On #815's displaced-owner/session-death fact, emit and persist `session_process_exited` through the total observation function even if `sessionStateManager.markDead` never ran. Source-facing push delivery is best-effort, but the telepty sequence is queryable until the orchestrator durably consumes it; the orchestrator's pre-existing unknown record prevents silence throughout that interval.
4. `markSessionConnected`, `session_reconnect`, an open owner WebSocket, a fresh `owner_token`, loopback origin, or SID equality cannot set `session_authentication:"available"`. Availability requires a #815 verification fact binding the current owner connection to the exact active `session_epoch`, with that epoch neither revoked nor displaced.
5. If #815 supplies no verified epoch—for a legacy restored bridge or any failed/ambiguous replacement—Stage A emits `session_authentication_unavailable` with the named reason and leaves completion unknown.

Cross-machine sender identity remains unavailable in 0.8.0 and is recorded as such; #817 must define it before any 0.9.0 remote report can become authoritative.

#### Stage A deployment — a maintenance truth fence, not a rolling upgrade

There is **no zero-downtime ordering** of the current telepty daemon and tracker that keeps every emitted statement truthful:

- orchestrator-first can stop the orchestrator from believing legacy events, but the old daemon can still emit false `TASK_COMPLETE`, `TASK_IDLE_UNCONFIRMED`, and external `idle` statements;
- daemon-first presents schema-v2 observations to the old tracker, whose `idle_notified`/404/fallback logic is not fail-closed;
- old and new daemons cannot both own `:3848`, and dual-emitting the legacy terminal labels is forbidden;
- a global package install normally stops and restarts a stale daemon (`scripts/postinstall.js:19-28`, `scripts/postinstall.js:81-131`), so merely “staging” the package can accidentally begin the cutover.

Consequently, “atomic” means a coordinated maintenance commit with a durable truth fence and a bounded `:3848` outage. It does not mean simultaneous repository merges. The system before the old daemon is stopped is already capable of lying; no deployment sequence can retroactively make that interval truthful.

Exact sequence:

1. **Pre-stage without activation.** Land the orchestrator's schema-v2 reader, dispatch freeze, migration state, and fail-closed tracker first, but leave them dormant. Build and verify the telepty release in a separate release path; if a global staging install is unavoidable, set `TELEPTY_SKIP_POSTINSTALL=1` so it cannot restart the live daemon. Do not change the executable used by new `telepty` invocations while dispatch remains open.
2. **Enter maintenance and migrate under the new registry transaction.** Acquire the stable orchestrator registry lock, reject new dispatches rather than holding them only in memory, stop the legacy tracker loop, and expose a maintenance state. Validate and preserve the legacy `active.json` bytes, then use the same temp-write/file-`fsync`/rename/directory-`fsync` component specified above to create one schema-v2 generation. Every `in_flight`/`re_dispatched` legacy record becomes `outcome.state:"unknown"`, `outcome.reported_value:null`, and `lifecycle.state:"cutover_quarantine"` while retaining its SID, dispatch metadata, and timestamps (`aigentry-orchestrator/bin/dispatch-tracker.sh:24-44`, `aigentry-orchestrator/bin/dispatch-tracker.sh:144-185`). Archive the legacy dispatch-helper sidecars while the fence is held; do not import them as delivery facts or dedup decisions. If parsing, validation, mapping, archival, or the durable commit fails, preserve the original bytes, keep dispatch closed, and abort activation; never initialize an empty registry or promote a legacy event.
3. **Stop the legacy producer.** Stop the old daemon and verify that `:3848` is closed before switching the installed release. During the outage the orchestrator serves maintenance plus the persisted unknown records; it does not serve cached terminal claims. If this bounded outage is unacceptable, the cutover is impossible under the present architecture.
4. **Start only schema v2.** Atomically switch the executable/release path, start the new daemon, and require `/api/meta` to report the completion-contract schema/capability—not merely a package version—before any consumer is enabled. A failed start remains fail-closed in maintenance; it must not roll traffic back to legacy outcome semantics.
5. **Restore transport observations, not outcomes.** Schema-v2 `tracked_injections` restore before readiness; pre-v2 `pendingReports` do not. Persisted wrapped-session metadata can be restored and bridges reconnect with backoff (`daemon.js:2662-2674`, `cli.js:1952-1993`). The old bridge may replay buffered PTY output and an unqualified `{type:"ready"}` (`cli.js:1840-1893`); schema v2 accepts those only as legacy activity/readiness observations.
6. **Keep all pre-cutover dispatches quarantined.** Because no schema-v2 transport-observation record exists for a pre-v2 inject, its observation endpoint returns explicit `tracking_unavailable/pre_v2_cutover`, not 404. A task may continue running across the restart, finish while `:3848` is down, or attempt a report that fails transport. Every case remains `completion_unknown`; process exit, reconnect, buffered output, and quiet are observations only. After the daemon is healthy, reconcile each record through a new authenticated/correlated request once Stage B exists, or leave it for explicit operator review/re-dispatch.
7. **Truth-contract canary, then consumer activation.** While dispatch is still frozen, prove end-to-end that the authoritative registry create is durable before telepty receives bytes, telepty tracking creates a persisted unknown, legacy `ready`/quiet/noise cannot settle either record, and the tracker retains rather than DELETEs it. Only then atomically change the already-landed orchestrator mode from `fenced` to `schema_v2` and restart its tracker loop.
8. **Reopen deliberately.** Reopen new dispatches only after the schema-v2 consumer is active. Continue exposing every quarantined pre-cutover record as unknown until an allowed authority settles it.

The tracker change therefore **lands before** the daemon release, **runs fenced during** the daemon replacement, and is **activated after** the daemon passes its schema-v2 truth-contract canary. Activating the old tracker against the new daemon, or the new tracker in legacy-compatible terminal mode against the old daemon, is not allowed. The semantic cutover is the maintenance transaction spanning steps 2–7.

One additional restart constraint must be explicit. Shipped verified-sender tokens exist only in daemon memory (`daemon.js:238-270`) and are not part of persisted session metadata (`src/session-store/persistence.js:11-45`). Re-registration returns a newly minted token (`daemon.js:2860-2897`), but the reconnect path ignores that response (`cli.js:1853-1877`), while the already-running child inherited the old token at spawn (`cli.js:1573-1588`). Therefore a restored 0.7.1 worker is transport-connected but **not an authenticated Stage-B reporter**. Stage A exposes authentication as unavailable and never upgrades it from reconnect status. Before a future Stage B can use that worker, #815 must supply an exact current epoch fact and #816 must supply a proven running-worker credential/capability channel; an unproven first claim remains unavailable under #818. Operationally, either:

- finish/manual-review its quarantined work and re-wrap it so initial registration supplies a current token; or
- separately design and test a restart-safe credential refresh channel that a running child can actually consume.

Silently accepting the claimed `from` field, or treating reconnection as re-authentication, would reopen the same false-authority defect.

### Stage B — 0.9.0 target, not part of the 0.8.0 proof

The authenticated correlated outcome protocol is deferred. Version 0.8.0 neither implements nor claims its “only measurement.”

- **#815 — local session epoch and honest owner lifecycle.** This ships in 0.8.0. Stage B may consume only a #815 verification fact for the exact current epoch; bare SID, claimed `from`, loopback status, owner-token possession, and WebSocket connection status remain insufficient. Sessions whose initial owner claim is not proven stay explicitly unavailable; #818 tracks the launcher-held pre-registration secret needed to close that first-claim class.
- **#816 — private capability delivery/report channel.** No such channel exists. The wrapper reaches the child only through PTY `child.write()` (`cli.js:1710`, `cli.js:1758`, `cli.js:1928-1931`, `cli.js:2005`); credentials enter only through spawn-time environment (`cli.js:1573-1588`); there is no `telepty report` command or local report IPC. Therefore the prior claim that a wrapper privately receives/attaches a per-dispatch capability is withdrawn. #816 must define and prove the channel before Stage B has a measurement.
- **#817 — cross-machine sender identity.** `remoteInject` forwards `--from` as a plain SSH command argument (`cross-machine.js:269-283`), while the receiving daemon treats the resulting local inject as `origin:"trusted-local"` and host-local epoch verifiers do not cross hosts. Until #817 defines end-to-end peer/host/session authentication and replay/correlation semantics, every remote sender identity and report capability is unavailable.

The 0.9.0 target remains:

1. keep internal `dispatch_id` out of worker-visible task bytes and public `inject_written` content;
2. bind a one-use report capability to the durable `(dispatch_id, assigned host, assigned sid, assigned session epoch)` record;
3. deliver and spend that capability only through #816's proven channel;
4. authenticate local senders with #815 and remote senders with #817;
5. emit `TASK_REPORTED_*`, never bare `COMPLETE`, only after the orchestrator atomically validates and consumes that fact.

These are target constraints, not accepted facts about existing infrastructure. The current reverse-match uses body `from`, gates on volatile `pendingReports`, and clears before broadcasting (`daemon.js:3953-3954`, `daemon.js:4047-4089`); it is removed in 0.8.0 rather than adapted into Stage B.

### Stage C — optional fact-capable execution adapters

This stage is not required for A1-A4. It reduces “unknown” frequency:

- a one-shot execution mode may correlate one dispatch to one child process and treat that direct child exit as “invocation exited”; outcome still depends on the execution contract;
- a CLI-native control-plane hook may be admitted only if it arrives out of band and its emitter/turn identity is authenticated;
- an in-band PTY escape never qualifies, regardless of pairing quality.

In 0.8.0 every unsupported command remains explicitly unknown. An explicit-report fallback exists only after the 0.9.0 #816/#817 prerequisites are implemented; zero external dependency still requires a local built-in path then.

### Stage D — compensation cleanup, separate change

Do not remove the `#32/#48/#52/#537/#545/#619/#721` stack in Stage A. It can continue to reduce observation noise and support delivery/readiness.

After the v2 outcome path is proven:

- elapsed completion floor and launcher completion floor become wholly redundant;
- `strongSubmitConfirmed` becomes literal submit-confirmation telemetry only;
- the launcher watermark remains useful as `submit_accepted_and_output_advanced` telemetry but cannot populate a consumption field;
- `unconfirmedSettleDone` can be replaced by ordinary observation debounce; the outcome-blocking `idleNotified` bit was already removed in Stage A;
- OSC 133 reliability and surface-error relabeling remain classifier telemetry only;
- settle/CPU/output rechecks may be retained solely as UI-noise suppression.

Delete or simplify those pieces only in a separately scoped Rule 29 cleanup. Stage A does perform the required semantic split in §3.10: preserving the launcher calculation does not preserve its false `injectConsumedAt` name. The present code explicitly recognizes that a never-started worker can satisfy the launcher heuristic (`daemon.js:483-503`), so it is neither outcome nor consumption evidence.

## 4. Structural proof

### A1 — completion only from a fact

**Claim emitted in 0.8.0:** no terminal task claim; the only task-outcome statement is `TASK_COMPLETION_UNKNOWN`.  
**Only producer:** none. The registry component can initialize `outcome.state:"unknown"` and `outcome.reported_value:null` but exposes no terminal mutation.  
**Required fact:** unavailable in 0.8.0; #816 and #817 block the authenticated correlated report fact.  
**Only measurement admitted as task outcome:** none. #815 owner/session lifecycle facts remain lifecycle observations, never outcomes.

No PTY/activity module can produce a terminal event. CI rejects `TASK_COMPLETE`, `TASK_COMPLETE_WITH_REPORT`, `dispatch_outcome_reported`, `auto_reported`, and `tracker_class:"done"` in the 0.8.0 source. The schema-guaranteed outcome pointers and writer inventory in §3 make the no-terminal-writer proof structural rather than name-vacuous.

### A2 — absence is emitted, never silence

Immediately before telepty delivery, the orchestrator completes the lock/validate/temp-write/file-`fsync`/rename/directory-`fsync` `begin-delivery` transaction for `outcome.state:"unknown"`, `dispatch_tracking_started`, and lifecycle `delivery_attempt_started`. Earlier gate/readiness/preparation failures are named nonzero non-delivery results and create no cache to poison a retry. Failure of the begin transaction aborts delivery. Telepty persists `task_completion_unknown/tracking_started` before bytes are handed off. A crash after the attempt marker leaves the authoritative `delivery_state_unknown` record. Every later observation entry point—not only `fireAutoReport`—passes through the total cause classifier. Both ledgers survive daemon restart; an absent/corrupt telepty observation record returns named `tracking_unavailable`, never 404/silence. Waiting-pattern, repeated-error, thinking-timeout, duplicate quiet, ordinary process exit, #815 owner displacement/death, restart, and supersession each have named nonterminal outputs. A deduped call references and appends to an existing durable record; it cannot exit silently with neither a record nor a transport call.

### A3 — no output overclaims its measurement

The external vocabulary in §2.3 contains no `idle`, `done`, or `complete`. It is selected by normalized cause and required evidence, not destination state. Only a fresh post-submit non-busy→busy edge paired with an accepted, non-ambiguous submit confirmation may set `consumption.status:"observed"`, and it still carries `completion_fact:null`. A positive submit rejection has precedence and forces consumption `not_established`, even if a stale durable field or unrelated repaint exists. Launcher watermark/body-removal/echo observations remain literal and also set consumption `not_established`. Repeated error text becomes `repeated_error_pattern_observed`; a thinking timeout becomes `thinking_classification_timeout_observed`; process death becomes `session_process_exited`.

### A4 — capability gaps are explicit

Every dispatch record exposes independent transport, authentication, and outcome capabilities:

```json
{
  "capability": {
    "turn_boundary": "unavailable",
    "observation_tracking": "persistent",
    "session_authentication": "unavailable",
    "session_authentication_reason": "no_815_epoch_fact",
    "capability_delivery": "unavailable",
    "capability_delivery_reason": "816_not_implemented",
    "remote_sender_identity": "unavailable",
    "remote_sender_identity_reason": "817_not_implemented",
    "outcome_protocol": "unavailable",
    "outcome_protocol_reason": "stage_b_deferred_to_0.9.0",
    "outcome_authority": "orchestrator"
  }
}
```

No timer, silence threshold, prompt glyph, spinner, SID claim, HTTP loopback status, `?owner=1` WebSocket SID claim, `owner_token`, reconnect event, git commit, or PTY output can change `turn_boundary`, `session_authentication`, capability delivery, remote sender identity, or outcome protocol to available. `session_authentication` becomes available only from a #815 fact binding the current authenticated owner to the exact live session epoch; displacement/revocation invalidates it. The other unavailable fields remain unavailable throughout 0.8.0.

## 5. OSC 9;4 disposition

**Decision: OSC 9;4 cannot be made A1-grade on the current PTY channel. Do not use it as a completion fact.**

The positive evidence is real:

- in `claude-2turn.raw.bin`, turn one opens at byte 4449 and closes at 9222; turn two opens at 9549 and closes at 13825. The submit marks are 4429 and 9529 (`claude-2turn.marks.json`), so each open follows the local CR by 20 bytes.
- `claude-modal.raw.bin` opens at byte 4415 after the submit mark at 4395 and has no close.
- `claude-err2.raw.bin` opens at 4455 and closes at 28471 after an error-killed turn.
- `codex.raw.bin`, `agy.raw.bin`, and `agy2.raw.bin` contain zero OSC 9;4 occurrences; all archived raw captures contain zero OSC 133 occurrences.

But none of the proposed hardening supplies emitter identity:

| Hardening | What it proves | Why it is insufficient |
|---|---|---|
| marker offset after our CR | temporal order | a child emits after the same CR |
| ignore closes not opened | parser consistency | a nested determinate-progress clear occurs inside the parent open |
| depth counting | balanced byte pattern | nested emitters share the byte stream and can close the parent's depth |
| reject bracketed-paste/echo | marker was not recognized as input echo | `cat` or a tool can output the same bytes later |
| gate by wrapper command `claude` | wrapper identity | every descendant's stdout is still attributed to that wrapper |

The bridge receives one undifferentiated `child.onData` stream and relays it unchanged to the daemon (`cli.js:2066-2087`). There is no per-emitter metadata to recover. `stripAnsi` then deletes OSC strings (`session-state.js:146-153`).

OSC 9;4 may be exposed as `osc_progress_clear_observed` telemetry. It must never enter the completion-fact factory.

OSC 133 is also unusable as currently written: the regex accepts only A/B and immediately transitions to idle (`session-state.js:71-74`, `session-state.js:205-212`). Those are prompt/command-start markers, not a paired command-end fact.

## 6. Per-CLI capability table

| Wrapped command | Current output-channel fact? | Truthful result without explicit report | A1-grade gap closure |
|---|---|---|---|
| Claude Code 2.1.220 | **No.** OSC 9;4 is paired in observed normal turns but in-band and unattributed. | `TASK_COMPLETION_UNKNOWN`; include OSC observation if desired. | authenticated correlated REPORT, or an official out-of-band turn-end control channel |
| Codex 0.145.0 | **No.** `codex.raw.bin` has zero OSC 9;4/133; OSC 0 spinner/title changes are activity only. | `TASK_COMPLETION_UNKNOWN`; prompt/spinner observations only. | authenticated correlated REPORT, official control channel, or isolated one-shot invocation |
| Gemini CLI | **Unverified behavior and no fact.** The capture has static OSC 0 at bytes 39 and 4501 and zero OSC 9;4/133 (`gemini.raw.bin`). | `TASK_COMPLETION_UNKNOWN` with capability reason `unverified_cli_protocol`. | first verify live turn behavior, then still require an authenticated out-of-band channel or REPORT |
| Antigravity `agy` 1.1.7 | **No.** Both direct captures contain zero OSC bytes (`agy.raw.bin`, `agy2.raw.bin`). | `TASK_COMPLETION_UNKNOWN`. | authenticated correlated REPORT or official control channel |
| generic wrapped shell/REPL | **No A1-grade fact.** The measured end prompt may be genuine, but `/[❯>$#%]\s*$/` accepts untrusted current-frame content (`cli.js:1674-1675`, `cli.js:1718-1723`). | `TASK_COMPLETION_UNKNOWN`; emit `prompt_suffix_observed`. | authenticated correlated REPORT, or a new one-dispatch/one-child mode whose direct child exit is observed |

The important distinction for generic commands is sample truth versus detector soundness: seeing a genuine prompt in the measured bash/zsh sample does not prove that every future regex match has prompt provenance.

In this table, “authenticated correlated REPORT” is a 0.9.0 target requiring #815 session epochs, #816 capability delivery/report transport, and #817 on cross-machine paths. The shipped 0.7.1 SID token does not qualify.

## 7. Disposition of established items 1–10

| Item | Disposition |
|---|---|
| 1. sticky `unconfirmedSettleDone` | Stage A keeps the code but removes outcome authority from it. Initial unknown is already emitted; the latch can only debounce follow-up observations. Delete in Stage D. |
| 2. `idleNotified` burned by wrong label | Remove it from the Stage-A observation contract, including the outer `onTransition` guard at `daemon.js:126` and assignment at `daemon.js:796`. Persisted observation identity handles dedupe. The future 0.9.0 report path is independently total and cannot consult this dedupe state. |
| 3. consumption gate bare return | Replace with a total provenance result. Only a recorded fresh busy edge plus accepted, non-ambiguous submit confirmation yields `consumption.status:"observed"` and `completion_fact:null`; positive rejection takes precedence over any recorded field, while launcher/body-removal/echo evidence yields its literal observation plus `consumption.status:"not_established"`. No silent return. |
| 4. WAITING absorbing | Emit `input_request_pattern_observed` immediately and retain initial unknown. No need to invent completion or force an idle transition. State-machine cleanup is separate. |
| 5. ERROR absorbing/history-wide | Classify by entrance: repeated-error emits `repeated_error_pattern_observed` with fingerprint/count/window; thinking-timeout emits `thinking_classification_timeout_observed` with duration only. Never infer task error. Retain initial unknown. |
| 6. ready-signal can confirm | Ready is permanently nonterminal; add `ready_kind/detector/cli_key`. |
| 7. `sawWorkingAfterInject` as completion | Retain only as activity/consumption evidence. It cannot enter outcome validation. |
| 8. elapsed ≥ 1s confirms | Elapsed time becomes an observation field only. Remove completion-floor code in Stage D. |
| 9. ready means opposite things | Qualify the signal per detector and use it only for inject readiness. Neither registry-tail composer detection nor generic prompt suffix is a completion fact. |
| 10. arbitrary reverse payload becomes `report_complete` | Delete `resolveOutboundReportStatus` fallback and the entire reverse-text report path in 0.8.0. An ordinary reverse inject cannot affect outcome. A dedicated report-control path may exist only in Stage B after #816/#817. |

### 7.1 Adversarial repairs V1–V3

| Finding | Design change | Why it closes the finding |
|---|---|---|
| V1 — SID re-registration discloses an unrevoked bearer; bus leaks correlation | #815 ships as a 0.8.0 security/lifecycle prerequisite, but Stage B is deferred until #816 supplies private capability delivery and #817 supplies remote identity. `dispatch_id` stays internal. The weak “imposter uses its own token” test is not security evidence. | Version 0.8.0 emits no outcome, so the missing Stage-B measurement cannot be exploited as outcome authority; 0.9.0 cannot start until all named facts exist. |
| V2 — restart deletes `pendingReports`; reverse report and absence both go silent | Stage A replaces volatile task authority with a durable orchestrator dispatch record plus persisted telepty transport observations. Missing observation state is an explicit 200 `tracking_unavailable`; all observation entry points are total. Version 0.8.0 has no report endpoint; the future Stage-B path is independent of the observation ledger and reverse-route gate. | Restart cannot erase the authoritative unknown and 404 cannot fall through. In 0.9.0, a genuine post-restart report cannot require a reconstructed daemon pending entry. |
| V3 — prompt/git/cleanup inference still writes terminal `auto_reported`/`reported` | The orchestrator schema separates `outcome`, lifecycle, gates, and observations. In 0.8.0 the registry component can only create `outcome.state:"unknown"`/`outcome.reported_value:null`; prompt class, git commits, errors, disconnect, and cleanup stay nonterminal. `tracker_class:"done"`, `AUTO_REPORT/auto_reported`, SID-only `mark-reported`, and inference fallthrough are removed or renamed as observations. | The external rename can no longer route into a second hidden completion factory; every fallback preserves the exact outcome fields. |

### 7.2 Round 6 repairs R1–R3

| Finding | Design change | Why it closes the finding |
|---|---|---|
| R1 — authoritative orchestrator record is best-effort and written after delivery | The design specifies one durable `begin-delivery` transaction that creates the unknown `delivery_attempt_started` record using a stable lockfile, validated v2 envelope, same-directory temp, file `fsync`, atomic rename, and directory `fsync`. Any write/corruption failure aborts before telepty; a post-begin crash leaves durable `delivery_state_unknown`. | Delivered task bytes can no longer exist without the authoritative unknown record. Corruption cannot silently become an empty registry. |
| R2 — outcome single-writer test scans a nonexistent name and misses live writers | The guaranteed fields are exactly `outcome.state` and `outcome.reported_value`. A repository-derived inventory includes direct writers in tracker, reconciler, and HITL; indirect callers in dispatch, inject-handler, and cleanup; and the cleanup-scheduler reader. All registry access routes through one typed transactional component, while the legacy inject-handler outcome hook is removed; 0.8.0 exposes no terminal mutation. | The invariant checks required schema pointers and every write entrance, including runtime-restored HITL status and textual REPORT handling, rather than grepping an absent token. |
| R3 — WS SID owner claim can kill the assignee while reporting reconnect | #815 owns the claim fix. Stage A consumes its authenticated owner-replaced/death facts as `owner_replaced_observed` and `session_process_exited`, invalidates the displaced epoch's authentication capability, and includes owner displacement in totality. A4 now excludes WS SID claims, owner tokens, and reconnect status. | The assigned process can disappear without `markDead` and still produce durable explicit absence; a replacement socket cannot keep authentication falsely available. |

### 7.3 Round 7 repairs F1–F3

| Finding | Design change | Why it closes the finding |
|---|---|---|
| F1 — one internal state/field launders multiple measurements | §2.3 now classifies `(destination, normalized cause, required evidence)` exhaustively and fails closed as `unmapped_transition_cause`. Repeated-error and thinking-timeout have different names/fields. Only fresh post-submit non-busy→busy provenance may set consumption observed; launcher/body/echo signals retain literal names. | Neither the `error` state nor `injectConsumedAt` can lend a stronger external name to an entrance that did not measure it. |
| F2 — pre-delivery sidecar dedup exits successfully without a record | The sidecar loses all decision authority. A read-only `check-dedup` precedes fallible preparation and locked `begin-delivery` rechecks atomically while creating the unknown attempt. Pre-begin failures leave no mark; ambiguous attempts are held explicitly; accepted duplicates reference/append to the existing record. | Every accepted/ambiguous invocation has a durable unknown record, while every earlier abort fails explicitly and is immediately retryable; a stale mark cannot swallow an identical retry. |
| F3 — test inventory is handed down and misses the legacy schema harness | A repository grep-derived inventory in §8.7 names the shared root-array/status harness and all 25 affected tests, with their outcome/lifecycle/gate/observation migration. | Implementers cannot leave legacy fixtures green against fields and terminal states that 0.8.0 removes. |

### 7.4 Round 8 repairs B1–B3

| Finding | Design change | Why it closes the finding |
|---|---|---|
| B1 — unrelated busy edge overrides positively rejected submit | Keep the accepted `fresh_busy_transition` name, but admit it only with `submitConfirm.accepted:true`, `ambiguous:false`; rejected confirmation is evaluated first and suppresses even a stale durable field. | A repaint or busy-indicator match after rejected/ambiguous/missing submit confirmation remains literal activity and cannot assert consumption. |
| B2 — exit-0 dedup suppression is recorded as successful auto-redispatch | `DISPATCH_DEDUPLICATED` now exits 8; only exit 0 authorizes redispatch counter/lifecycle/deadline changes. Both production callers handle 7/8 as held/suppressed observations without advancement. | Exit-code-only callers can distinguish a new transport write from no-op deduplication, so the ledger cannot record a re-dispatch that never happened. |
| B3 — widened producer vocabulary lacks consumer coverage | §8.5 adds one shared table-driven consumer matrix over every §2.3 cause/name and every list/status/MCP/sidebar adapter. Unknown/missing mappings fail neutral. | No newly literal quiet/prompt/manual/OSC name can fall through to the old green/done presentation. |

## 8. Regression specification

Every §8.1 test aimed at the idle-promotion branch keeps the live state at `idle`/`pty_quiet` when that timer fires; none use the vacuous “state is working, so return before the target branch” shape. The new cause-classification tests intentionally drive their named thinking/error entrances instead.

### 8.1 RED tests against 0.7.1

| Test | Exact setup and assertion | Predicted unpatched failure |
|---|---|---|
| `elapsed_is_not_completion` | `fireAutoReport`, plain pending inject, elapsed 5.0s, trigger `real-idle`; assert no terminal outcome and one unknown observation. | `non-fact measurement emitted terminal outcome: TASK_COMPLETE: worker is now idle after processing inject (5.0s, via real-idle inject=probe)` |
| `working_edge_is_not_completion` | same, elapsed 0.2s, `sawWorkingAfterInject:true`; assert unknown. | `non-fact measurement emitted terminal outcome: TASK_COMPLETE: worker is now idle after processing inject (0.2s, via real-idle inject=probe)` |
| `submit_accept_is_not_completion` | `submitExpected:true`, `submitConfirmedAt` set, accepted `force`, elapsed 10s, trigger `real-idle`, and `idleEvidenceReliable:true`; with no fresh non-busy→busy edge assert consumption is not established and completion fact is null. The explicit true flag exercises the production reliable-idle promotion branch rather than relying on an omitted dependency. | `non-fact measurement emitted terminal outcome: TASK_COMPLETE: worker is now idle after processing inject (10.0s, via real-idle inject=probe)` |
| `consumed_settled_path_is_total` | `unconfirmedSettleDone:true`, `injectConsumedAt` set with `injectConsumedVia:"fresh_busy_transition"`, qualifying transition metadata, and `submitConfirm:{accepted:true,ambiguous:false}`; live state `idle`; assert exactly one unknown observation with `consumption.status:"observed"`. | `expected 1 completion-absence emission, got 0` (current bare return at `daemon.js:783-785`) |
| `fresh_busy_edge_requires_accepted_submit` | table-drive the same post-submit `idle→working` and `waiting→thinking` edges with (A) accepted/non-ambiguous, (B) accepted/ambiguous or force-only, (C) `accepted:false`, and (D) missing confirmation. Only A may set/retain `injectConsumedAt` and consumption observed. For C, also seed a stale `injectConsumedAt`; assert `submit_rejection_observed` and `not_established`, proving rejection precedence. | current `maybeRecordInjectConsumption` records all four edges, and `observeConsumptionEvidence` returns `consumed_recorded` before checking `accepted:false` |
| `duplicate_idle_transition_is_total` | tracked inject with the first idle observation already recorded; invoke `onTransition(..., to:"idle")` again; assert named `observation_duplicate`, retained unknown, and no terminal event. | `expected observation decision, got bare return at daemon.js:126` |
| `waiting_transition_reports_absence` | create pending, feed `Enter value:`, advance `_tick` 600s; assert one `input_request_pattern_observed`, state is not held at working. | `timed out waiting for task_completion_unknown after waiting transition` |
| `error_state_entrances_are_trigger_truthful` | table-drive (A) `deploy failed` ×3 and (B) a thinking pattern followed by `_tick` beyond 300s. Assert A is `repeated_error_pattern_observed` with fingerprint/count/window; B is `thinking_classification_timeout_observed` with `thinking_duration_ms` and no error-pattern fields. Both retain unknown. | no v2 cause mapper exists; a destination-state mapper would falsely return `error_pattern_observed` for B |
| `launcher_watermark_is_not_consumption` | wrapped session, submit attempted, force/ambiguous accept, output ring advanced, elapsed ≥30s, and no fresh non-busy→busy edge. Invoke the launcher path then consumption classification; assert `submit_accepted_and_output_advanced`, `consumption.status:"not_established"`, and no `injectConsumedAt`. | current `maybeRecordLauncherConsumption` sets `injectConsumedAt`/`launcher_watermark`; `observeConsumptionEvidence` returns `{observed:true, reason:"consumed_recorded"}` |
| `every_state_entrance_has_literal_observation` | table-drive every §2.3 producer entrance, including both OSC entrances, manual mark, both error entrances, and three lifecycle marks. Assert the exact name and required fields; delete one mapping and assert `unmapped_transition_cause`, never a destination-state fallback. | current external serialization is state-name based and cannot distinguish the table rows |
| `dead_reports_absence_to_source` | pending inject then `markDead(1,null)`; assert bus plus source-facing `session_process_exited`, `completion_fact:null`. | `expected 1 source completion-absence notification, got 0` (current dead branch only broadcasts at `daemon.js:142-159`) |
| `arbitrary_reverse_message_is_not_report` | call reverse classifier with `Can you clarify the requirement?`; assert `null`. | `expected null, got "report_complete"` |
| `external_idle_is_renamed` | internal FSM produces silence-timeout idle; serialize/list/status event; assert external value `pty_quiet` and basis `silence_timeout`. | `expected "pty_quiet", got "idle"` |
| `ready_frame_is_qualified` | bridge harness for Claude registry-tail and generic `$ ` current frame; assert distinct `ready_kind` values and no outcome. | `expected ready_kind "composer_surface_observed", got undefined` |
| `pending_overwrite_emits_superseded` | create second tracked inject for same SID; assert old inject gets `tracking_superseded` and remains queryable by `inject_id` before the active pointer changes. | `expected tracking_superseded for old inject, got only console overwrite warning and destructive replacement` |

The elapsed, working-edge, and consumed-settled probes were executed directly against the exported `fireAutoReport` seam on 2026-07-29; they produced two `TASK_COMPLETE` messages and one zero-emission result. The earlier submit-accept probe omitted `idleEvidenceReliable`, so its claimed RED evidence is withdrawn. The corrected fixture above pins `idleEvidenceReliable:true`, which selects the production promotion at `daemon.js:700-715`; it must be executed RED before implementation. WAITING remained waiting and repeated-error remained error after a synthetic 600s tick, matching `session-state.js:338-353` and `session-state.js:390-394`.

### 8.2 #815 security prerequisite tests

These are imported acceptance properties for the parallel #815 scope, not an issue-#60 design of its mechanism. They gate the lifecycle facts consumed by Stage A:

1. `reregister_cannot_disclose_bearer`: first owner registers `victim`; a second origin-less loopback client POSTs the same SID with no epoch/bearer. Assert denial and no credential field. Unpatched failure: 200 with the victim's byte-identical `session_token` (`daemon.js:2897`).
2. `loopback_is_transport_trust_not_owner_auth`: repeat from 127.0.0.1 with no `Origin`; assert the credential endpoint still requires owner bootstrap/current proof. Unpatched failure: middleware calls `next()` before checking a token (`src/protocol/http-auth.js:138-149`).
3. `restart_does_not_reissue_authority`: register, restart against the same state directory, and assert an unauthenticated re-registration cannot mint or recover owner authority. #815 may restore a previously proven epoch or expose authentication unavailable, but it cannot silently trust a bare SID. Unpatched failure: the token maps are empty after restart, followed by unauthenticated replacement issuance.
4. `delete_revokes_epoch`: register, DELETE/kill the session, and assert the old bearer no longer resolves. Unpatched failure: no cleanup path deletes from `sessionTokens`/`sidTokens`.
5. `sid_reuse_gets_new_epoch`: destroy and recreate the same textual SID; assert a new epoch and rejection of the predecessor bearer. Unpatched failure: `mintSessionToken` returns the predecessor token still keyed by SID.
6. `ws_sid_claim_is_not_authentication`: open `?owner=1` from loopback with only a known SID; assert it cannot replace the verified owner or set `session_authentication:"available"`. Unpatched failure: unconditional owner replacement plus a fresh `owner_token` (`src/transport/websocket.js:116-159`).
7. `owner_replacement_emits_lifecycle_fact`: perform a #815-authorized replacement; assert an authenticated `owner_replaced` fact names the displaced epoch and a later owner/session-death fact is emitted when the bridge exits.
8. `unproven_first_claim_stays_unavailable`: exercise a session class without #818's launcher-held pre-registration proof; assert explicit `session_authentication_unavailable/first_claim_unproven`, never inferred availability. This does not require #818 to ship in 0.8.0.

### 8.3 Restart and totality tests

1. `tracking_unknown_survives_restart`: persist a tracked inject, restart the daemon, query by `inject_id`, and assert the original `completion_fact:null`, observation sequence, and `daemon_restart_observed`; unpatched behavior is 404 because `pendingReports` is memory-only.
2. `missing_tracking_is_explicit`: query a pre-v2 or absent `inject_id`; assert HTTP 200 `tracking_state:"unavailable"` plus reason and `completion_fact:null`. Assert the tracker records HOLD and `continue`s without screen/git fallback.
3. `tracking_persist_failure_prevents_delivery`: force the telepty observation-state write to fail; assert the target receives no task bytes and the orchestrator retains explicit `tracking_persistence_failed` unknown.
4. `orchestrator_registry_failure_prevents_inject`: make mandatory `check-dedup`/`begin-delivery` fail via missing helper, lock timeout, disk-full/write error, or `fsync` seam; assert `do_inject`/telepty is never invoked, no sidecar is written, and dispatch exits with the named record failure. This reverses the current best-effort contract at `dispatch.sh:351-377`.
5. `orchestrator_record_precedes_inject`: spy the registry and telepty seams and assert the single durable unknown `delivery_attempt_started` commit completes before the first telepty call, with no fallible preparation between them. Unpatched failure is inject at `dispatch.sh:620` before append at `:634`.
6. `crash_after_delivery_attempt_keeps_unknown`: persist `delivery_attempt_started`, allow the transport call, then terminate before the post-call mutation; restart and assert the record becomes/remains `delivery_state_unknown`, with no automatic reinject and no terminal outcome.
7. `corrupt_registry_fails_closed`: seed malformed/wrong-schema/duplicate-ID state; assert original bytes are preserved, a health error is emitted, and dispatch, tracker, HITL, reconciler, scheduler, cleanup and pruning perform no mutation or actuation.
8. `atomic_registry_crash_preserves_generation`: fail between temp write, file `fsync`, rename, and directory `fsync`; after each fault, assert recovery sees either the complete old generation or complete new generation, never empty/partial JSON.
9. `all_observation_entrypoints_return_decisions`: table-drive transition, ready, dwell, settle, CPU/output rearm, consumption, duplicate-idle, ordinary death, #815 owner replacement/death, supersession, cancellation, and restore; assert no eligible path returns `undefined` and none writes outcome.
10. `owner_displaced_without_markdead_reports_absence`: with a tracked dispatch, feed #815's owner-replaced then death facts without calling `sessionStateManager.markDead`; assert both ledgers contain `owner_replaced_observed`/`session_process_exited`, authentication for the old epoch is unavailable, and completion stays unknown.
11. `predelivery_abort_retry_matrix`: for task-gate rejection, spawn/readiness/registration timeout, target-resolution/temp-ref failure, and every dedup-query/begin validation/write failure, immediately invoke an identical valid retry. Assert no legacy sidecar or accepted dispatch record was created by the failed call and the retry reaches `begin-delivery` rather than returning success early.
12. `dedup_transport_accepted_is_explicit`: seed the same dedup key with `transport_write_observed`; retry and assert no telepty call, exit 8, one durable `dedup_suppressed` observation, and discriminated `DISPATCH_DEDUPLICATED` output naming the prior `dispatch_id`, `new_delivery:false`, and `completion_fact:null`. Assert exit 0 is impossible on this path.
13. `dedup_ambiguous_attempt_is_held`: seed `delivery_attempt_started` and `delivery_state_unknown` cases; retry and assert no telepty call, durable `dedup_retry_held`, exit 7, and `DISPATCH_RETRY_HELD` rather than “OK already dispatched.”
14. `dedup_observation_failure_is_not_success`: force the registry append for either dedup decision to fail; assert a named registry failure, nonzero exit, and no telepty call.
15. `legacy_sidecar_has_no_authority`: create the current `$HOME/.aigentry/dispatch-helper/<sid>` hash with no v2 record; invoke dispatch and assert the sidecar is ignored/archived and a durable v2 attempt is created. Unpatched behavior exits 0 at `dispatch.sh:609` with no registry or telepty call.
16. `deduped_auto_redispatch_does_not_advance`: exercise both `dispatch-tracker.sh` and `session-reconciler.sh` with the original SID/ref and a dispatch stub returning exit 8. Assert neither sets lifecycle `re_dispatched`, increments `re_dispatch_count`, nor extends `expected_report_by`; each records `redispatch_suppressed_duplicate`. Repeat with exit 7 and assert the held observation. Only a stubbed exit 0 may advance all three fields.

### 8.4 OSC containment tests

These are permanent green controls, not claimed RED tests:

1. Feed exact slices around `claude-2turn.raw.bin` offsets 4449/9222/9549/13825 into observation parsing; assert zero completion facts.
2. Feed `9;4;3 … 9;4;1;10 … 9;4;1;90 … 9;4;0`; assert zero completion facts.
3. Feed an unpaired nested `9;4;0`; assert zero completion facts.
4. Feed the escape inside bracketed paste, echoed input, and later `cat` output; assert zero completion facts.
5. Source-invariant: 0.8.0 contains no terminal outcome validator/producer. The future 0.9.0 validator must not import the OSC parser or session-state module.

Unpatched 0.7.1 should pass the “OSC 9;4 does not complete” behavioral controls because it currently strips/ignores OSC 9;4. If any is reported RED against unpatched source, the test is wired to the wrong premise.

### 8.5 Consumer contract tests

1. `telepty list --json`: no external `autoState.state:"idle"`; completion capability and last observation are present. Unpatched failure: `expected activity observation "pty_quiet", got autoState.state "idle"`.
2. `telepty status`: heading says “Activity observation,” not “State,” and never colors `pty_quiet` as task success. Current rendering calls the field `State` (`cli.js:2696-2715`). Unpatched failure: `expected /Activity observation:/; output contained "State: 💤 idle"`.
3. MCP list/status: connected/quiet/completion capability are separate lines; neither tool calls a connected session complete. In 0.8.0 it renders `Outcome protocol: unavailable (Stage B deferred: #816, #817)`. Current MCP list only reports connection status (`mcp-server/index.mjs:86-105`).
4. dispatch tracker: unknown produces HOLD/poll, preserves `outcome.state:"unknown"` and `outcome.reported_value:null`, never DELETEs observation history, and has no terminal settle operation in 0.8.0. Unpatched failure: `expected unknown after AUTO_HOLD, got 404 plus inference fallthrough`.
5. cmux/sidebar adapter: `pty_quiet` renders as neutral quiet, not done/green-success. The existing state table maps internal idle to a green sleeping pill (`session-state.js:42-50`), and codex detector comments identify the sidebar pill as a consumer (`session-state.js:99-103`). Unpatched failure: `expected neutral "pty_quiet" pill, got green "idle" pill`.
6. prompt glyph plus an attributable new commit: `session-probe.py` returns only `prompt_observed`; tracker appends a nonterminal review snapshot and retains the exact unknown/null outcome fields. Unpatched failure: class `done` falls through and status becomes `auto_reported` (`session-probe.py:130-151`, `dispatch-tracker.sh:326-333`, `dispatch-tracker.sh:525-548`).
7. telepty 404/empty/new-schema cases: each becomes a named unknown and executes `continue`; replace the current T36 expectation that 404 falls through to AUTO_REPORT (`tests/dispatch/T36_pending_404_falls_through.sh`).
8. git fallback: new commit/test output may create `worktree_activity_observed` with `review_required:true`, but cannot change outcome or stop later polling. Replace terminal expectations in T8/T10/T42/T58.
9. cleanup/disconnect/error: cleanup sets lifecycle `cleaned`, disconnect sets connectivity, and error sets an error observation; none calls SID-only `mark-reported` or changes either outcome field. Unpatched cleanup calls `mark-reported` solely because the session disappeared (`session-cleanup.sh:237-252`).
10. schema-bound single-writer invariant: require `outcome.state`, `outcome.reported_value`, `lifecycle.state`, `dedup.key`, and `dedup.ref_hash` in every v2 record; reject every production write/open-truncate/rename of `active.json` outside the registry component; reject outcome-field assignments outside it; and assert the 0.8.0 component exposes only unknown/null outcome creation. Explicitly cover tracker, `session-reconciler.sh:170-218`, `hitl.sh:97-159`, dispatch, `inject-handler.sh:93-108`, cleanup, and the cleanup-scheduler reader. Also reject `auto_reported`, `mark-reported`, `tracker_class:"done"`, and any post-cutover dispatch-helper sidecar authority.
11. legacy REPORT envelope in 0.8.0: feed `inject-handler.sh` a syntactically valid existing REPORT envelope; assert it cannot call a tracker terminal operation or change either outcome field and returns ordinary-message/nonterminal `outcome_protocol_unavailable`. Unpatched failure: the `report` arm calls `mark-reported "$sid" || true` (`inject-handler.sh:93-108`).
12. `consumer_vocabulary_matrix_is_total`: table-drive all 14 §2.3 producer rows, expanding the owner-replaced/death row into both emitted names, through `telepty list --json`, `telepty status`, MCP list/status, bus serialization, and the cmux/sidebar adapter. Every name has an explicit nonterminal presentation; quiet/prompt/OSC/manual markers are neutral, output/busy markers may render active, request/error/timeout/death markers may render warning/error, but none renders done, task success, terminal outcome, or green-success. Delete any mapping or inject an unknown name and assert neutral `unmapped observation`, never fallback to internal `idle` or success styling.

### 8.6 Deferred Stage-B prerequisite tests

These specify the 0.9.0 admission gate; they are not 0.8.0 acceptance tests and their absence cannot be papered over by PTY data:

1. `missing_control_channel_keeps_outcome_protocol_unavailable`: prove the 0.8.0 command table has no report command/local IPC and every path from wrapper to child is PTY bytes or spawn-time environment; assert capability delivery and the outcome protocol remain unavailable rather than synthesizing a report measurement.
2. `capability_delivery_is_not_worker_visible_data_plane`: after #816, deliver a one-use capability to the exact assigned epoch without putting it in PTY bytes, task text, `inject_written.content`, bus/audit serialization, or process-spawn environment; prove a sibling local process cannot obtain it.
3. `remote_claimed_from_is_not_identity`: on the existing SSH `remoteInject` path, forge `--from`; assert no authenticated sender fact. After #817, require an end-to-end host/peer/session proof bound to the assigned epoch and reject replay on another host or epoch.
4. `report_after_daemon_restart_ignores_observation_state`: after #816/#817, restart telepty and submit a valid report through the dedicated channel; assert validation consults the orchestrator's durable dispatch record and never `pendingReports` or `tracked_injections`.
5. `one_use_capability_consumption_is_atomic`: submit two concurrent copies of the same valid capability; assert exactly one `TASK_REPORTED_*` transition and one replay rejection, with no bare `COMPLETE`.

### 8.7 Orchestrator test migration inventory

This inventory was re-derived from the repository with a broad grep over `AUTO_REPORT|AUTO_HOLD|mark-reported|pendingReports|idle_notified|t_seed_entry|active.json|t_assert_status|["status"]|get("status")`, followed by inspection to exclude `T16`/`T26` comment-only hits and `T59`'s separate task-queue status schema. The result is the shared harness plus 25 affected tests:

| Group | Files | Required migration |
|---|---|---|
| shared registry harness | `tests/dispatch/lib.sh` | `t_setup` seeds `{schema_version:2,generation:0,dispatches:[]}` rather than `[]`; replace status-shaped `t_seed_entry`/`t_assert_status` with schema-validating `t_seed_dispatch`, `t_assert_outcome_unknown`, `t_assert_lifecycle`, `t_assert_gate`, and `t_assert_observation` helpers |
| terminal inference/report/cleanup | `T8_pull_auto_report.sh`, `T10_auto_report_idempotent.sh`, `T17_lifecycle_3layer.sh`, `T31_autoreport_wiring.sh`, `T41_cleanup_marks_reported.sh`, `T42_git_autoreport_shared_cwd_skip.sh`, `T58_git_autoreport_worktree_attribution.sh` | delete `AUTO_REPORT`, `mark-reported`, and pull-terminal expectations; assert literal observations/lifecycle plus unchanged unknown/null outcome |
| volatile pending decision API | `T35_pending_autohold.sh`, `T36_pending_404_falls_through.sh`, `T37_pending_idle_false_noop.sh`, `T38_pending_curl_fail_continues.sh` | replace `/api/pendingReports/:sid`, `idle_notified`, 404, and curl-fallthrough fixtures with schema-v2 `/api/inject-observations/:inject_id` 200 bodies and explicit unavailable/unknown handling |
| overloaded registry status/lifecycle/gate | `T1_tracker_welcome.sh`, `T2_tracker_error.sh`, `T3_tracker_active.sh`, `T9_redispatch_cap.sh`, `T21_scheduler_keep_alive_skip.sh`, `T22_reconciler_gc_root_and_sweep.sh`, `T28_session_probe_policy.sh`, `T29_reconciler_shadow_loop.sh`, `T30_dispatch_registration.sh`, `T51_register_on_delivery_failed.sh`, `T62_hitl_blocking_status.sh`, `T63_hitl_destructive_pause.sh`, `T64_hitl_approve_resume.sh`, `T66_policy_await_user.sh` | map `in_flight`/delivery to lifecycle, `awaiting_user` to `gate.state`, redispatch to lifecycle/attempt count, error/welcome to observations/review gates, and keep-alive to its own field; no test may assert `reported`, `auto_reported`, or another outcome-like status |

Specific previously hidden assertions are reversed: `T62:78` can no longer reach `reported`; `T62:32,74` and `T64:20,82` assert `gate.state:"awaiting_user"` without changing outcome; `T2:13`/`T64:94` assert error observations rather than `stuck_error`; `T9:16`/`T63:133` assert redispatch lifecycle; and every old root-array seed is a schema-v2 envelope. A source/fixture invariant rejects `printf '[]' > active.json`, `e["status"]`, `t_assert_status`, and terminal status literals in this test subtree, except an explicitly named legacy-migration input fixture.

## 9. Version and rollout impact

Version 0.8.0 is intentionally breaking and contains only Stage A plus #815:

- legacy `TASK_COMPLETE:` and `TASK_COMPLETE_WITH_REPORT` are removed from heuristic/reverse-message paths;
- bus event names and external activity values change;
- `/api/pendingReports/:sid` is retired as a decision API; `/api/inject-observations/:inject_id` returns the persisted discriminated observation/capability schema, including explicit unavailable;
- `telepty list --json` no longer exports task-like `idle`;
- dispatch tracker behavior changes from idle-triggered AUTO_HOLD+DELETE and screen/git AUTO_REPORT to unknown-triggered HOLD+poll plus nonterminal evidence snapshots.
- the pre-ledger `$HOME/.aigentry/dispatch-helper/<sid>` dedup sidecar is retired; dedup becomes a typed registry transaction with explicit held exit 7 and suppressed-without-new-delivery exit 8. Exit 0 means a new transport write and its durable transport-result commit both succeeded.

The package is currently 0.7.1 (`package.json:3`). Recommend **0.8.0 with schema_version 2** and an explicit breaking-change notice. Do not dual-emit the old false statements during a compatibility window: that would violate the zero-false-statement requirement. A pre-announcement is fine; a false legacy overlap is not.

Consumer effects:

| Consumer | Impact |
|---|---|
| cmux sidebar pill | value/meaning changes to activity observation; no done semantics |
| `telepty list --json` | breaking value/schema change; consumers must use `activityObservation` and `completion` separately |
| CLI `telepty status` | new labels/color mapping; internal submit FSM unchanged |
| MCP tools | no branch currently depends on `autoState`; descriptions/output should expose the new separation |
| orchestrator dispatch tracker | required lockstep change; split outcome/lifecycle/observation axes, stop `idle_notified`/404 fallthrough, remove terminal AUTO_REPORT and SID-only mark-reported |
| orchestrator probe/policy/reconciler/cleanup | prompt, git, error, disconnect, and cleanup become observations/lifecycle only; none may write reported outcome |
| bus subscribers | migrate from `session_auto_state`/`TASK_IDLE_NO_REPORT`/`TASK_COMPLETE*` to v2 observation events only; report events do not exist until 0.9.0 |

The orchestrator registry migration is part of the 0.8.0 maintenance transaction, not a lazy first-read conversion. Dispatch remains fenced until the root-array legacy file has been validated and durably converted into the versioned envelope. Stage B has a separate 0.9.0 release gate: #815's exact local epoch facts must be available, #816 must provide the owner-authenticated capability/report channel, and #817 must provide cross-machine sender identity. Issue #818 does not block Stage A; any session class it leaves unproven remains explicitly authentication-unavailable.

## 10. Surgical implementation scope after approval

### 10.1 Version 0.8.0 — Stage A

Likely telepty files:

- `daemon.js` — total cause-based observation dispatch across every caller, persisted tracked-inject lifecycle, explicit observation endpoint, removal of heuristic/reverse terminal production, and consumption admission requiring an accepted non-ambiguous submit with rejection precedence.
- `src/session-store/persistence.js` — versioned atomic persistence/restore of transport-observation records; explicit migration/corruption result. Current session-only serialization is insufficient.
- `src/transport/websocket.js` — ready qualification, no auto completion, and consumption of #815's authenticated owner-replaced/death lifecycle facts.
- `cli.js` — ready qualification and truthful status/list rendering.
- `session-state.js` — keep the internal FSM; normalize overloaded producer triggers, prevent caller override of the normalized cause, and export the exhaustive cause/evidence observation mapper.
- `src/report-enforcement.js` — remove arbitrary-message/reverse-route completion; it contains no report-envelope validator in 0.8.0.
- `mcp-server/index.mjs` — truthful output wording.
- focused new/updated tests from §8.

Parallel security issue #815 is also in the 0.8.0 release boundary and owns its own design, implementation files, and security acceptance. Issue #60 consumes only its public facts: an authentication result bound to the exact current session epoch; invalidation when that epoch is revoked or displaced; and authenticated owner-replaced/session-death events that identify the displaced epoch. Bare SID, loopback status, owner-token issuance, WebSocket connection, and reconnect are explicitly not substitutes. The likely `http-auth`/WebSocket/teardown surfaces remain #815 scope rather than being redesigned here.

Required orchestrator files:

- a single transactional registry component (for example `bin/dispatch-registry.py`, using only the standard library) — stable lock, schema validation, typed dedup-query/begin-delivery/observation/lifecycle operations, durable atomic replace, corruption failure, and the sole write access to `state/dispatch/active.json`.
- `bin/dispatch.sh` — retire the sidecar dedup gate; query dedup before fallible preparation, atomically recheck and create the exact unknown/null `delivery_attempt_started` record immediately before telepty, reserve exit 0 for a new transport write plus durable result commit, and return explicit held/suppressed exit 7/8 otherwise.
- `bin/inject-handler.sh` — remove the legacy textual REPORT-to-`mark-reported` hook; 0.8.0 has no terminal outcome protocol.
- `bin/dispatch-tracker.sh` — split outcome/lifecycle/observation axes; unknown/HOLD/poll semantics; no DELETE, 404 fallthrough, terminal AUTO_REPORT, or SID-only mark-reported; advance redispatch state only on dispatch exit 0 and record exit 7/8 as held/suppressed without counter/deadline mutation.
- `bin/session-probe.py` — replace completion-like `tracker_class:"done"` with literal prompt observation.
- `bin/policy.py` — keep probe classes operational/nonterminal.
- `bin/session-reconciler.sh` — remove direct `active.json` writes, replace pull-AUTO_REPORT with typed nonterminal evidence/lifecycle operations, preserve unknown dispatches, and apply the same exit-0-only redispatch advancement contract.
- `bin/hitl.sh` — remove `r+` registry writes; set/restore only the gate axis through typed operations.
- `bin/session-cleanup.sh` — record cleanup lifecycle without marking a dispatch reported.
- `bin/dispatch-cleanup-scheduler.sh` — replace its direct `ACTIVE_JSON` read with a schema-validating read and fail closed on corrupt/unavailable state.
- `tests/dispatch/lib.sh` and all 25 grep-derived tests in §8.7, plus the new durability/dedup/measurement-cause/totality/single-writer tests — migrate the harness and reverse every legacy single-status or terminal-inference expectation.

No external library is needed. The only new state concepts in issue #60 are the persisted transport-observation record and the orchestrator-owned dispatch record with separate outcome/lifecycle/gate/observation axes. Keep one pure observation decision function and one transactional orchestrator registry component. Version 0.8.0 has no outcome validator and no terminal mutation seam.

### 10.2 Version 0.9.0 — deferred Stage B

Do not assign a file-level implementation scope yet: the defining infrastructure does not exist. #816 must first choose and prove an owner-authenticated control/capability-delivery/report IPC that is neither PTY bytes nor spawn-only environment. #817 must choose and prove end-to-end cross-machine sender identity for the SSH/peer path. Only then may Stage B scope a report command/IPC, capability store, and the orchestrator's single terminal outcome validator. #818 separately governs session classes whose initial owner claim remains unproven.

## 11. Verification performed in design phase

- The telepty target repo remained read-only and `git status --short --branch` was clean on `main`; this round changed only this sandbox design artifact. The separately inspected orchestrator worktree already contained unrelated user changes, which were not modified.
- Direct capture byte scan verified the offsets and zero OSC 133 counts cited above.
- `node --require ./test-support/setup-env.js --test test/session-state.test.js`: **52/52 pass**.
- `node --require ./test-support/setup-env.js --test test/enforce-submit-gate.test.js`: **10/10 pass** and reproduces elapsed/working/submit-confirmed promotion to `TASK_COMPLETE`.
- A combined six-file baseline run reached 104 passing subtests but did not terminate cleanly because three daemon-importing files retained pending process handles; it was manually stopped after 72s and the runner marked those three files cancelled. This is a baseline-harness issue, not a product-code result. No production code or test file was changed.
- Adversarial verification supplied a hermetic reproduction that unauthenticated same-SID re-registration returns the victim's byte-identical token. This design does not claim the 0.7.1 credential as authentication.
- The earlier submit-accept direct probe was vacuous with respect to the production idle-evidence branch and is not counted as validation; §8.1 now specifies the corrected fixture.
- A reviewer tested same-UID environment inspection on macOS with a planted secret and observed zero hits because `ps eww` redacted the other process's environment. Linux same-UID exposure through `/proc/<pid>/environ` is plausible but **unverified here**. This design therefore makes no platform-universal claim that another same-UID process can read spawn-time environment; #816 is required because spawn-time environment cannot deliver a new per-dispatch capability to an already-running worker.
- Round 6 performed source and contract inspection only; no implementation or new test execution was authorized.
- Round 7 re-grepped every `session-state.js` transition/lifecycle entrance. It confirmed distinct repeated-error and thinking-timeout entrances, five distinct routes into internal idle/readiness state, and overloaded `lifecycle`/`osc_133_prompt` trigger strings; §2.3 now enumerates them rather than serializing the state name.
- Round 7 re-grepped both `injectConsumedAt` setters and confirmed the launcher watermark reaches `observeConsumptionEvidence` as generic `consumed_recorded`; §3.10 splits that provenance.
- Round 7 inspected `dispatch.sh:288-294` and `:609-623`: the sidecar is written before readiness, the duplicate exits 0 before registry/telepty, and only registration-timeout/inject-failure arms currently clear it. The new dedup contract removes that authority rather than adding more cleanup exceptions.
- The test-tree grep produced `tests/dispatch/lib.sh` plus 25 substantive legacy-shape tests after excluding two comment-only hits and the separate task-queue schema; §8.7 records the complete migration.
- The independent Round 7 tests-and-consumers lens reported an outright pass and executed every then-existing §8.1 RED test against unpatched 0.7.1, including the corrected submit-accept fixture, with each failing for its predicted reason. No new tests were run in this design-only revision.
- Round 8 source inspection confirmed `maybeRecordInjectConsumption` has no submit-confirmation conjunct and `observeConsumptionEvidence` reads `injectConsumedAt` before `accepted:false`; §3.10 now requires accepted/non-ambiguous confirmation and reverses that precedence.
- Round 8 source inspection confirmed both auto-re-dispatch callers discard stdout and treat dispatch exit 0 as permission to increment/extend redispatch state. The revised exit contract reserves 0 for a new durably recorded transport write, with held/suppressed results on 7/8.
- The independent Round 8 preservation checks and the cause-mapping lens passed outright. This revision did not alter §2.3, §8.7, or the mechanically preserved sections; no implementation or new tests were run.

## HOLD decision

The ownership boundary is decided: telepty supplies transport/authentication measurements; the orchestrator alone owns dispatch outcome.

Version 0.8.0 is Stage A plus #815 and emits no terminal task outcome; every dispatch remains explicitly `unknown` unless a human or separate orchestrator authority settles it outside this protocol. Stage B is deferred to 0.9.0 and cannot begin until #816 and #817 supply the currently nonexistent capability-delivery and remote-identity facts. #818 leaves unproven first-claim session classes explicitly unavailable.

Round 7 additionally makes every external activity/consumption name measurement-cause-specific and makes deduplication an explicit registry decision; neither internal state names nor a stale sidecar can assert a stronger fact or create silence.

Round 8 closes the remaining admission and consumer edges: a busy edge needs accepted non-ambiguous submit evidence, dedup suppression cannot masquerade as successful redispatch through `$?`, and every cause has a tested nonterminal consumer presentation.

Implementation remains unauthorized. Hold for re-verification of this revised design.
