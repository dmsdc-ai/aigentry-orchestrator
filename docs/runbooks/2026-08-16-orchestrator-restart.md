# Runbook — restarting the orchestrator (and what to do when it will not come back)

Covers tasks **#905** (the fix) and **#907** (this document). Location chosen to match the
existing `docs/runbooks/<date>-<slug>.md` convention; the other runbook here is
`2026-06-13-608-phase1-rollback.md`.

---

## Symptom

Worker report injects bounce with:

```
❌ [STALE] Session is stale and awaiting cleanup.
```

`telepty list` shows the orchestrator as `STALE` with `Clients: 0`:

```
- orchestrator (local) [claude] - STALE  - Clients: 0
```

The daemon reports the underlying reason as `OWNER_DISCONNECTED_STALE`
(`daemon.js:1533`): the session record exists, but the bridge that owned it is gone.

**Nothing else will tell you this is happening.** Workers keep working and keep reporting;
their reports simply land nowhere. Since #905 the reconciler raises an
`ORCHESTRATOR_STALE` alert after 5 minutes — see [Detection](#detection) below.

---

## Fix — one command

```bash
bin/orchestrator-boot.sh
```

Since #905 that is sufficient on its own. It now does three things in order:

1. **Reconciles the registry record.** If the daemon's record for the orchestrator sid is
   `STALE` with 0 attached clients, it is `DELETE`d. This is the step that used to be
   missing, and without it the boot below cannot succeed (see [Why](#why-a-restart-used-to-be-impossible)).
2. **Singleton guard.** `SIGKILL`s any pre-existing `telepty allow --id orchestrator`
   process, never itself or an ancestor (so self-restart from inside the orchestrator is
   safe). `kill -9`, never `-TERM` — the SIGTERM handler cascades a DELETE to co-bound
   clients.
3. **Boots**, with `--auto-restart`.

Verify:

```bash
telepty list | grep orchestrator     # expect CONNECTED, Clients: 1+
```

---

## Why a restart used to be impossible

Measured during the 2026-08-16 incident (3h20m outage):

1. The daemon on `:3848` was replaced (a CLI sweep SIGTERMed it; launchd restored it).
2. The orchestrator's bridge did not re-register. Its record went
   `OWNER_DISCONNECTED_STALE`, `Clients: 0`.
3. Re-running `orchestrator-boot.sh` found **no process to kill** (`killed=0`) — correct,
   the bridge really was gone — and exec'd a fresh `telepty allow`, which the daemon
   refused:

   ```
   ❌ [allow] Owner claim refused for session 'orchestrator' — this bridge does not hold its current credential
   ```

   Under telepty's owner-token model (#815, landed 2026-07-30) the **STALE record still
   held the dead bridge's owner token**. A record nobody owned and nobody could claim.

4. The manual fix was to delete the record and boot again:

   ```bash
   curl -X DELETE -H "x-telepty-token: <master>" \
     http://127.0.0.1:3848/api/sessions/orchestrator
   # {"success":true,"status":"closing"}
   ```

Step 1 of `orchestrator-boot.sh` is now that DELETE, done automatically and only in the
one shape where it is safe.

### Why the workers survived and the orchestrator did not

The incident's first reading was that workers survived because they carry `--auto-restart`.
**That is not the cause** (measured in `cli.js` 0.8.0):

- `--auto-restart` is referenced at exactly two places, `cli.js:2576` and `:2605`, both
  inside `attachChildExitHandler`. It respawns the **wrapped child CLI** when it exits
  abnormally (1s→8s backoff, `MAX_CRASHES`, counter reset after 30s). Nothing else.
- WS reconnect and re-register are **unconditional** and independent of the flag
  (`scheduleReconnect`, and the `reconnectAttempts > 0` re-register at `cli.js:2224-2256`),
  landed 2026-03-14.

The real differentiator is **bridge image age**. The orchestrator's bridge was started
**2026-07-25**, five days *before* #815 landed (2026-07-30). A long-running process keeps
executing the code it loaded at start, so its image had no `session_token` adoption
(`cli.js:2247-2255`) — on reconnect it could not adopt the new instance's bearer, and its
owner claim was refused. Workers were spawned *after* #815 and adopted it fine.

**Practical consequence:** after upgrading telepty, a long-lived orchestrator bridge is
running the *old* client against the *new* daemon. Restart it deliberately rather than
discovering the mismatch during an outage.

`--auto-restart` is still on the boot line since #905, on its own merits: without it a
`claude` crash takes the entire orchestrator session down. Workers have always had it.

---

## Detection

Since #905, `bin/session-reconciler.sh` (step 2a) raises, once per tick:

```
ORCHESTRATOR_STALE sid=orchestrator health=STALE for 12000s (>= 5m) — worker reports are
bouncing '[STALE] Session is stale and awaiting cleanup' and nothing is reading them.
Remedy: run bin/orchestrator-boot.sh ... WARN-ONLY: this tick will not touch the orchestrator.
```

**Where it lands:** `emit_alert` writes to `$DISPATCH_STATE_DIR/alerts.log` **and** tees to
the tick's stderr, which under launchd is `reconciler.log`.

```bash
tail -20 "${DISPATCH_STATE_DIR:-$HOME/.aigentry/state}/alerts.log" | grep ORCHESTRATOR_STALE
```

**Why it is not an inject:** the alert reports that the orchestrator is down, and a STALE
session is precisely the one that bounces injects. Sending it there would be posting the
outage notice to the room that is on fire.

**Threshold:** `ORCH_STALE_ALERT_MIN`, default 5 minutes. Below it, nothing is emitted — a
bridge that dropped seconds ago is usually mid-reconnect.

**WARN-ONLY, permanently.** The reconciler never kills or deletes the orchestrator:
lifecycle is user-actuated (#606).

---

## If `orchestrator-boot.sh` still does not recover it

Read its own log lines first — it says which branch it took.

| What it logged | Meaning | Do |
|---|---|---|
| `no record for 'orchestrator'` | Registry is already clean | The exec should work; the failure is elsewhere |
| `is CONNECTED (clients=N) — left alone` | A live orchestrator already holds the id | You may not need a restart; check whether you are looking at a second terminal |
| `is DISCONNECTED ... left alone` | Bridge dropped recently, may be reconnecting | Wait one minute and re-run |
| `STALE but N client(s) are attached` | Someone is still attached | Detach that client, then re-run |
| `STALE but the listing reports no client count` | Older daemon payload | Do the manual DELETE above, then re-run |
| `DELETE ... → 401` / `403` | Daemon refused the credential; **the record stays** | Check `authToken` in `~/.telepty/config.json` is readable, then re-run |
| `DELETE ... → no answer` | Daemon is not up | `telepty daemon` / check launchd, then re-run |
| `reconcile SKIPPED — ... did not answer` | Daemon unreachable at pre-flight | Same as above; boot still proceeded, so read the `allow` error too |

### Hard rules

- **Never** `kill -TERM` an orchestrator bridge. The SIGTERM handler cascades a
  `DELETE`/'Session destroyed' close to every co-bound client, which is how the live
  orchestrator self-exited on 2026-06-07. The guard uses `kill -9` for exactly this reason.
- **Never** run `telepty allow --id orchestrator` bare. It bypasses both the record
  reconcile and the singleton guard — the two things that make the restart work.
- Orchestrator cleanup stays **user-actuated**. No automation in this repo kills or deletes
  a *live* orchestrator; #905 only removes a record that is provably unowned (STALE, zero
  clients).
