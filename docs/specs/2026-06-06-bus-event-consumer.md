# SPEC — Orchestrator bus-event consumer (#528: kill "Enter 안눌림")

- **Status:** DRAFT — SPEC FIRST (Rule 24), awaiting orchestrator review. No code written.
- **Author:** architect session `bus-consumer-spec-architect-bus-consumer`
- **Date:** 2026-06-06
- **Target repo:** `aigentry-orchestrator`
- **Related:** #517 (reconciler PULL-fallback), #528 (this), telepty ENFORCE-REPORT (landed ~0.2.0, running 0.5.2)

---

## 1. Problem (verified live)

A worker's REPORT/HOLD `telepty inject` into a **busy** orchestrator claude TUI does not
reliably submit ("Enter 안눌림"). #517 added a reconciler PULL-fallback, but it only covers
**COMPLETION** — a session that is GONE from telepty **and** authored a git commit
(`dispatch-tracker.sh:_git_check_and_autoreport`, lines 404–436). It does **not** cover the
**alive-session HOLD** case: an architect (SPEC FIRST, no commit) that wrote a spec file and
attempted a HOLD inject that silently failed to submit. The worker stays alive, goes idle, and
its HOLD is lost — caught only by manual screen-polling. This recurs on nearly every dispatch.

**This very SPEC's HOLD inject is expected to hit the bug** — hence the deliverable is this file,
and the HOLD inject is attempted only as a best-effort signal.

---

## 2. Investigation — ground truth (cited)

### 2.1 The emitter EXISTS and is DEPLOYED — but in telepty, not deliberation

| Claim | Verdict | Evidence |
|---|---|---|
| Bus events emitted | ✅ | `aigentry-telepty/daemon.js` — `broadcastSessionEvent()` (daemon.js:960) → `broadcastBusEvent()` (daemon.js:323) |
| Which daemon | **telepty**, port **3848** | `daemon.js:155` `PORT = process.env.PORT || 3848`. deliberation (0.0.45) has **no** `pendingReports`/`enforce-report` code. |
| Deployed in running version | ✅ telepty **0.5.2** running; feature landed 0.2.0 | `telepty --version` → `0.5.2`; `report-enforcement.js` present. |
| deliberation relevance | ❌ none | deliberation is a bus *consumer* (turn_request), not the emitter. Ignore for #528. |

> **Correction to the brief:** the emitter is **telepty**, not deliberation. The brief's
> "deliberation mailbox" framing is wrong; the enforce-report impl lives in
> `aigentry-telepty/src/report-enforcement.js` + `daemon.js`.

### 2.2 The five events and when they fire

| Event | Trigger (daemon.js) | Clears pendingReport? |
|---|---|---|
| `TASK_IDLE_NO_REPORT` | worker `working→idle` while `pendingReports[sid]` exists & `!idleNotified` (daemon.js:86–93, fire at 286–294) | no — sets `idleNotified=true`, `idleAt` |
| `TASK_DEAD_NO_REPORT` | worker `→dead` while pending exists (daemon.js:96–114); payload carries `auto_summary` + `exit_detail` | **yes — `delete` BEFORE broadcast** (daemon.js:99) |
| `TASK_COMPLETE_WITH_REPORT` | recipient receives an inject whose prompt matches a REPORT prefix & reverse-matches `pending.source` (daemon.js:2478–2507) | yes |
| `TASK_BLOCKED_WITH_REASON` | same, prompt `^STATUS: blocked` (report-enforcement.js:14,37) | yes |
| `TASK_DISMISSED` | `^STATUS: dismissed` inject **or** `DELETE /api/pendingReports/:id` (daemon.js:2491,2623) | yes |

A `pendingReports[sid]` entry is created for **every** inject that carries `from`
(daemon.js:2514–2528): `{source, injectedAt, injectId, awaitingReport:true, idleNotified:false}`.

### 2.3 ⚠️ The transport the brief assumes DOES NOT EXIST

The brief says "poll `GET /api/pendingReports`". **There is no list endpoint.** Confirmed by
enumerating every route in `daemon.js`. Only these exist:

- `GET /api/pendingReports/:id` (daemon.js:2587) — inspect **one** entry by sid; returns
  `auto_summary` lazily when `DELIBERATION_REPORT_AUTO_SUMMARY_ON_QUERY!=false` (default on,
  daemon.js:50,2595; built by `report-enforcement.js:buildAutoSummary` — ANSI-stripped,
  secret-redacted, 40 lines / 4096 bytes).
- `DELETE /api/pendingReports/:id` (daemon.js:2614) — dismiss (fires `TASK_DISMISSED`).
- WebSocket push bus `ws://127.0.0.1:3848/api/bus` (websocket.js:272) — `broadcastBusEvent`
  fans out to connected `busClients`. **Fire-and-forget: no buffer/replay.** An event emitted
  while no client is attached is **lost**.

`GET /api/pendingReports/:id` response shape (daemon.js:2596–2610):

```json
{
  "session_id": "...", "source": "orchestrator", "inject_id": "uuid",
  "injected_at": "ISO8601", "idle_notified": true, "idle_at": "ISO8601|null",
  "awaiting_report": true, "submit_expected": false,
  "submit_in_progress": false, "submit_confirmed_at": null,
  "submit_unconfirmed_at": null, "saw_working_after_inject": true,
  "auto_summary": "…tail of worker screen, ANSI-stripped, redacted…"
}
```

**Auth: send the token. ⚠️ AMENDED 2026-07-30 (#824) — this section previously said the
opposite.** It read "localhost is always trusted (`http-auth.js:24–36`) — no token needed for a
same-host orchestrator", which was true when written and is being made false on purpose.
Loopback trust was a vulnerability, not a feature (telepty #820/#823: any local process, and via
wildcard CORS any page the user merely visits, got full read/write on the daemon including
`POST /api/sessions/spawn`). telepty 0.8.0 removes it, after which a token-less call to any
`/api/*` route gets **401**.

So a consumer built from this spec **MUST** present the credential:

```bash
# bin/lib/telepty-auth.sh is the ONE resolver in this repo — source it, do not
# re-implement it. It resolves `authToken` from ~/.telepty/config.json (the same file
# the telepty CLI reads) and prints empty on any failure, never erroring.
. "$SCRIPT_DIR/lib/telepty-auth.sh"
curl -s -H "x-telepty-token: $(telepty_auth_token)" \
  "http://127.0.0.1:${TELEPTY_PORT:-3848}/api/pendingReports/${sid}"
```

Two constraints that are part of the contract, not implementation detail:

- **Do not add an env override.** The file is the single source of truth. The daemon freezes its
  token at module load (`daemon.js:33` → the `http-auth.js` / `websocket.js` closures) and its
  production launchd plist supplies only `PATH`, so it can never see a `TELEPTY_AUTH_TOKEN`; a
  client honouring one would present a token the daemon does not expect and get a 401
  indistinguishable from a real credential bug.
- **401 is not 404.** See §4 — a refusal and an absence must not collapse into one branch.

`GET /api/health` is the sole exception: it is registered at `daemon.js:311`, *before*
`app.use(createAuthMiddleware(...))` at `daemon.js:316`, so it stays reachable unauthenticated.
Nothing in this spec's flow uses it.

### 2.4 Existing orchestrator seams (#517) to integrate with — NOT duplicate

- **Reconcile loop:** `session-reconciler.sh` loops every `RECONCILER_LOOP_INTERVAL` (default
  **60s**, lines 580–590). Each `--once` tick runs **Step 0b** (lines 600–608):
  `dispatch-tracker.sh check`.
- **`check`** (`dispatch-tracker.sh:250–316`): for each `active.json` entry with status
  `in_flight|re_dispatched` whose `expected_report_by ≤ now`, it reads the screen, classifies,
  and — for non-active classes — calls `_git_check_and_autoreport` (line 404).
- **Idempotency ledger:** `state/dispatch/auto-reports.seen`, TSV `sid<TAB>head_sha`, checked
  with `grep -qxF` (line 410), appended after emit (line 428).
- **Surfacing (3 channels, all reused):** append JSON to `state/dispatch/auto-reports.log`
  (line 420), append text to `state/dispatch/alerts.log` (line 430), and **best-effort**
  `telepty inject --from dispatch-tracker orchestrator "AUTO_REPORT …"` (lines 431–435).
- **Liveness:** `telepty list --json` (reconciler `telepty_list_json`, lines 394–402);
  `session_disconnected` per sid in the tracker (line 277).
- **HTTP precedent already exists:** `session-cleanup.sh:delete_session_registry` already does
  `curl -H "x-telepty-token: $(telepty_auth_token)" -X DELETE
  http://127.0.0.1:${TELEPTY_PORT:-3848}/api/sessions/<sid>`, and
  `dispatch-tracker.sh:_poll_observations_and_hold` does the same for
  `/api/inject-observations/:id`. So adding a curl to `GET /api/pendingReports/:sid` introduces
  **no new dependency** (§17 satisfied — curl + the daemon are already in use) — but copy the
  *credentialed* form above, not the bare curl this spec originally showed (#824).
- **Precondition:** dispatch must inject with `--from <orch>` (`dispatch.sh:230`) so
  `pending.source` is set. active.json `from_sid` is `orchestrator` in practice. If a dispatch
  omits `--from`, no pendingReport is created and no idle event fires — call this out in review.

---

## 3. Design decision — extend the reconcile loop, poll by id (recommended)

### 3.1 Recommendation: **poll `GET /api/pendingReports/:sid` inside `dispatch-tracker.sh check`** — reject a WS listener

| Option | §1 경량 / §17 | Robustness | Verdict |
|---|---|---|---|
| **A. Per-sid HTTP poll in the existing tick** (recommended) | No new process/port/dep; reuses the 60s loop, the curl precedent, the seen-ledger, the 3 surfacing channels | pendingReport **persists** in daemon until cleared → a missed tick is re-read next tick. Idle survives. | ✅ |
| B. Persistent WS `/api/bus` listener | New always-on connection + reconnect/supervision logic = a new long-lived component (§1 violation), needs launchd unit | bus is fire-and-forget; an event during a reconnect gap is **lost forever** | ✗ primary |
| C. (brief's assumption) poll list endpoint | — | endpoint **does not exist** | ✗ impossible |

**Why poll-by-id is sufficient (no list endpoint needed):** the orchestrator already holds the
exact set of sids to watch — `active.json` in-flight entries. We don't need generic bus
consumption; we need the state of *our* dispatches. The tracker already iterates them; add one
curl per in-flight sid. This is the most §1-경량 option and unifies with #517 into one
"observe worker state" pass.

**Decisive robustness point:** the WS bus has no replay. The #528 bug is exactly "the signal
didn't land." Choosing another fire-and-forget channel to fix a lost-signal bug reintroduces
the failure mode. Polling persistent daemon state is the correct shape.

### 3.2 Where it lives

Extend `dispatch-tracker.sh check` — a new step in the existing per-entry loop (around
lines 290–312), running **before** the git-check fallthrough, so one pass observes both
"alive & idle/blocked" (new) and "gone & committed" (#517):

```
for each in-flight entry past expected_report_by:
   liveness = session_disconnected(sid)              # existing
   pr = GET /api/pendingReports/:sid                  # NEW (curl + x-telepty-token, 127.0.0.1:3848)
   if pr.idle_notified == true and not already-seen:  # NEW — the #528 fix
        synthesize AUTO_HOLD (pr.auto_summary + spec/git evidence) → surface → mark seen → DELETE pr
   elif class == active:  _bump_expected(sid)         # existing
   else:                  _git_check_and_autoreport(...)   # existing #517 (covers dead+commit)
```

### 3.3 Per-event behaviour

- **`TASK_IDLE_NO_REPORT` (the gap, alive worker):** seen via `idle_notified:true` on the GET.
  Synthesize an **AUTO_HOLD**:
  1. take `auto_summary` straight from the GET response (worker's screen tail — already
     redacted by the daemon);
  2. enrich with existing #517 evidence — `_git_shortstat` and, for a SPEC dispatch, the
     expected spec path from the dispatch ref (e.g. detect a `docs/specs/*.md` written since
     `dispatched_at`);
  3. surface (§3.4) as `AUTO_HOLD sid=… idle_for=…s summary="…" — review/respond required`.
- **`TASK_BLOCKED_WITH_REASON`:** only emitted if a `STATUS: blocked` inject *landed* (which
  also clears the pending). If it landed, the orchestrator already saw it. If it did **not**
  land (the bug), the worker goes idle → caught by `idle_notified` above. So the consumer needs
  no separate blocked path; idle is the catch-all. (Note for review: `HOLD:` is **not** a
  recognized report prefix in `report-enforcement.js:13`, so a HOLD inject never clears the
  pending and never fires COMPLETE — idle is precisely the right signal.)
- **`TASK_DEAD_NO_REPORT`:** the daemon **deletes** the pending before broadcasting → a poll
  returns **404**. This case is already covered by #517 (session gone + git commit). The only
  loss is the dead-event `auto_summary`; acceptable because #517 pulls git-log/transcript
  evidence instead. (Optional phase-2: a thin WS tap purely to capture dead `auto_summary`.)
- **`TASK_COMPLETE_WITH_REPORT` / `TASK_DISMISSED`:** the worker's report landed and cleared the
  pending → poll returns 404 → nothing to do (the orchestrator already has the report).

### 3.4 Surfacing — reuse all three #517 channels, add an `AUTO_HOLD` kind

- `auto-reports.log`: `{"kind":"AUTO_HOLD","sid":…,"emitted_at":…,"idle_for_secs":…,"summary":…,"spec_path":…,"review_required":true}`
- `alerts.log`: `… AUTO_HOLD sid=… idle=…s spec=… — review/respond required`
- best-effort `telepty inject --from dispatch-tracker orchestrator "AUTO_HOLD …"` — and because
  this is the very channel that fails under #528, the **file logs are the source of truth**; the
  interactive orchestrator reads `alerts.log`/`auto-reports.log` on its idle turn regardless of
  whether the inject landed. (This is the actual fix: detection no longer depends on a push.)

### 3.5 Idempotency

`auto-reports.seen` currently keys on `sid<TAB>head_sha`. Idle has no sha. Extend the ledger key:
`sid<TAB>IDLE<TAB><inject_id>` (inject_id is stable per dispatch, from the GET response). One
AUTO_HOLD per (dispatch, idle) — re-dispatch gets a new inject_id, so a genuinely new idle
re-surfaces. After surfacing, optionally `DELETE /api/pendingReports/:sid` to free daemon memory
(it fires a harmless `TASK_DISMISSED` we ignore); the seen-ledger is the primary guard so DELETE
is belt-and-suspenders, not required for correctness.

---

## 4. Failure modes

| Mode | Behaviour |
|---|---|
| daemon down / curl fails | treat like existing `telepty list` failure — skip this entry's poll, log, continue. Non-fatal (matches reconciler's best-effort posture). |
| **401/403 — daemon refused the credential** (#824) | Record a reason that says *refused*, distinct from any "absent"/"not found" reason. Never fold it into the 404 branch: the pending record may well exist, and a consumer that reports absence here would claim more than it measured. Precedent: `dispatch-tracker.sh` maps 401/403 to `observation_poll_unauthorized` while 404 keeps `observation_endpoint_absent` (tests/dispatch/T84); `session-cleanup.sh` gives 401/403 their own arm rather than the "unexpected" catch-all (tests/dispatch/T86). |
| **token unresolvable** (no/unreadable `~/.telepty/config.json`) | `telepty_auth_token` prints empty and exits 0; curl then omits the header entirely and the daemon answers 401, handled by the row above. Degrade — never abort the tick, and never send an empty credential as though it were valid. |
| event emitted between ticks | no loss — `idle_notified` persists in the daemon; next ≤60s tick reads it. |
| duplicate surfacing | guarded by extended `auto-reports.seen` key `(sid, IDLE, inject_id)`. |
| dead before first poll | pending deleted → 404 → falls through to #517 gone+commit path. Documented loss = dead `auto_summary` only. |
| worker legitimately working | `idle_notified:false` → NOOP; existing `class==active` → `_bump_expected`. |
| `--from` omitted on dispatch | no pending created → no idle event. Precondition; flag in review. |
| auto_summary disabled (`…ON_QUERY=false`) | GET returns `auto_summary:null`; AUTO_HOLD still fires from `idle_notified` + git/spec evidence. |

## 5. Portability (§2) & test approach (hermetic)

- **Portability:** pure `curl` to `127.0.0.1:${TELEPTY_PORT:-3848}` carrying `x-telepty-token`
  (same form as `session-cleanup.sh:delete_session_registry`). No new dep (§17), no new
  port/daemon. Works wherever the reconciler already runs.
- **Hermetic tests** (no live daemon): a fixture HTTP responder (or a `curl` shim) returning
  canned `GET /api/pendingReports/:id` bodies. Cases:
  1. `idle_notified:true` + `auto_summary` → asserts AUTO_HOLD written to `auto-reports.log`,
     `alerts.log`, seen-ledger appended, inject attempted.
  2. second tick, same inject_id → **no** duplicate (seen-ledger hit).
  3. `404` (cleared/dead) → no AUTO_HOLD; #517 git path still runs.
  4. `idle_notified:false` → NOOP.
  5. curl failure (daemon down) → skip + log, tick continues.
  6. **the poll sends `x-telepty-token`** — assert on the stubbed curl's argv, or the fix is
     cosmetic and only shows up as a live 401 after 0.8.0 (#824).
  7. **`401` → a refusal reason, and NOT the 404/absent branch**; plus an unresolvable token
     degrading to a 401 rather than aborting the tick.
  Add under `state/dispatch/self-tests/` alongside existing reconciler self-tests.

## 6. [SAWP] envelope — architect, SPEC FIRST

Investigated telepty (daemon.js, report-enforcement.js, websocket.js, http-auth.js) +
orchestrator (session-reconciler.sh, dispatch-tracker.sh, dispatch.sh, session-cleanup.sh).
Design only; no code edits. Evidence-grounded with file:line. §1 경량 (extend the 60s tick, one
curl per in-flight sid — no new process). §17 (no new dep/port; curl + daemon already used).
Rule 24 SPEC FIRST. Open question for orchestrator: accept the documented dead-`auto_summary`
loss (rely on #517) vs add a phase-2 WS tap? Recommend: accept the loss for v1.
