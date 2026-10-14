# Worker reports — the confined report pump (#1170)

A confined worker (macOS sandbox-exec, Linux bwrap) cannot reach telepty: its
sandbox denies sockets, loopback and `~/.telepty`. So it never sends its report.
It writes the report into its own outbox, and the host-side **report pump**
captures it, records it in the dispatch registry and notifies the orchestrator.

## How a report travels

1. `dispatch` mints a `request_id` and a secret `challenge` per dispatch and
   appends a `REPORT_ENVELOPE` trailer to the worker's staged (read-only) ref.
   The registry stores the attempt, the manifest sha256, the request id and
   only the challenge's sha256.
2. The worker writes `$AIGENTRY_REPORT_OUTBOX/<request_id>/REPORT-<n>.md` (or
   `HOLD-<n>.md`), write-once, first line = envelope header, last line =
   `AIGENTRY_REPORT_END`. The prompt clause is in the boot contract,
   `tooling/instructions/common.md` and `tooling/dispatch-prelude/template.md`.
3. `dispatch-tracker report-pump` (every reconciler tick, or a loop you run)
   reads the outbox of the **attempt pinned at dispatch** (never
   `sandbox-current`), copies each complete, envelope-valid item to
   `state/dispatch/inbox/reports/<dispatch_id>/<KIND>-<n>-<sha256>.md`, records
   `captured`, then sends one notice as `dispatch-tracker`
   (`telepty inject --submit --no-submit-force`) to the record's destination.
4. You review it with `report-ack`. Until then the notice repeats on a durable
   schedule: +2, 5, 10, 20, 30 min, then hourly (`queued`/`gate_timeout` wait
   at least 30 min).

Per request the registry holds up to 32 `REPORT`, 32 `HOLD` (each its own
limit, as the prompt allows) and 64 `TURN` items.

## Timing

- One notice inject may take 90 s (then telepty is killed and the submit is
  `unknown`). Its claim lease is 2 min, which covers the inject plus a 25 s
  margin for recording the result.
- A claim names its pump (`owner=<pid>@<host>`). When a claim's lease has run
  out, the next pass handles it in one of two ways:
  - **The owner is provably gone** (same host, pid no longer exists, e.g. a
    crashed pump): the notice is claimed again and sent.
  - **The owner may still be sending** (alive, another host, or pid reuse):
    nothing is sent. The claim is recorded as `submit=unknown` and held 30 min
    (`REPORT_NOTICE_HELD … reason=claim_in_flight`). An unknown delivery is
    never re-sent at once and Enter is never forced.
  This holds for any two overlapping pumps: two reconciler ticks, or a
  `report-pump --loop` beside the reconciler. There is no lock file, so a crash
  cannot leave a stale lock.
- A pass stops starting records and injects 240 s after it began (real time,
  not `TRACKER_NOW`). That is below the reconciler's 300 s kill, so the health
  file is still written. The skipped work is due on the next pass. The pass
  reports `*:pass_deadline` (exit 3, `report-status` degraded).

## Commands

```bash
bin/dispatch-tracker.sh report-pump --once            # one pass (the reconciler runs this)
bin/dispatch-tracker.sh report-pump --loop 60         # Linux/Windows host: run it yourself
bin/dispatch-tracker.sh report-status [--json]        # obligations + pump health; exit 3 = degraded
bin/dispatch-tracker.sh report-ack --dispatch-id <D> --item REPORT-2 --sha256 <H> --verdict accepted
```

Every notice ends with the exact `report-ack` line to run. Verdicts:
`REPORT` accepted | rework | rejected · `HOLD` answered | rejected ·
`failure-<n>` and `legacy` seen.

## What each fact means — and does not

| Fact | Meaning | Not |
|---|---|---|
| `captured` | the worker's exact bytes are in the inbox | delivery, review or completion |
| `notice` `rc`, `inject_id`, `submit` | what the telepty CLI said | that anyone read it |
| `observed` `delivery_result` | the receiver's audit row for that inject | a review |
| `review` | your ACK | — |

Only an **accepted current REPORT** resolves a dispatch to `done`. `rework`
waits for the next REPORT number; a lower or older number is `superseded` and
an ACK naming it is refused (`STALE_SUBJECT`, exit 4). A HOLD is reviewed
independently. A worker that exits, dies, disappears, is cleaned up or misses
its deadline without a REPORT raises a **failure notice** (`exited`, `dead`,
`gone`, `cleaned`, `overdue`, `delivery_unknown`); `seen` makes it
`failed_seen`, which is not done, and a later REPORT reopens it. The outcome
axis stays `unknown`.
Failure notices are recorded once per kind, except `item_invalid` and
`item_conflict`, which are recorded once per item (`REPORT-n`/`HOLD-n`/`TURN-n`).
So a second bad item gets its own notice. A record holds at most 263 failures.

Records dispatched without an envelope (before this release, or to a target
whose sealed manifest has no outbox — dispatch prints
`REPORT_ENVELOPE_UNAVAILABLE`) become `legacy_unbound`: live, ungated records
only, at most 20 marked per pass, listed in one digest with the same backoff
until each is ACKed `seen`. Retired history is never notified.

## Cleanup

`session-cleanup.sh` captures every complete item of the session first. If a
capture fails it **refuses** the cleanup (exit 1) and preserves the worker files
and registry records; there is no override flag. A cleanup with no REPORT
captured records a `cleaned` failure. `prune` never removes a record whose
report is `open`, `rework_requested` or `legacy_unbound`. A
`failed_seen` record leaves `active.json` only when all of these hold:
- its lifecycle is retired;
- it is older than the prune cutoff;
- its last failure review is more than 7 days old. That is the pump's own scan
  window, so no pass looks at the record again.

Before the record is dropped, its full row is appended and fsynced to
`state/dispatch/report-archive.jsonl`. If that append fails, the record stays
and prune exits 9.

The archive is evidence, not authority: nothing reads it back. A crash can
repeat a line. The worker's inbox copies
(`state/dispatch/inbox/reports/<dispatch_id>/`) are never moved or deleted.
**Disk use therefore grows without bound** (inbox + archive). There is no
automatic erase; removing old evidence is an operator decision.

A file in the worker's outbox that the controller cannot read (e.g. the
worker made it `chmod 000`) is `io_error`. That is a capture failure: cleanup
refuses and nothing is repaired or bypassed. A malformed or forged item is
different. A REPORT/HOLD becomes an `item_invalid` failure notice. A TURN whose
status fields the registry refuses, such as a bound TURN naming
`<uuid>/REPORT-n`, is listed as `ignored`. Neither blocks cleanup.

## Activation and rollback

Source change only; nothing restarts. The new `dist/src/report/*`,
`dist/src/{dispatch,tracker,reconciler,cleanup}/…`, `dist/src/session/worker-sandbox.js`
(it stages `dist/src/report/turn-hook.js` into each new claude attempt)
and `bin/boot-prepare.mjs` go into the package, and `bin/dispatch-registry.py`,
`bin/lib/workspace-host.sh` (focus fix, see worker-focus.md)
and the two `tooling/` prompt files into the control workspace (then refresh
`~/.aigentry/instructions/common.md`). Verify each target still has the
expected pre-change sha256, back it up, rename the new file into place. The
next reconciler tick loads the new dist. Workers spawned **before** activation
have no outbox in their sealed manifest: respawn them to get mandatory
reporting; until then their dispatches are `legacy_unbound`.

Rollback: rename the backups back. The registry's added `report` /
`assigned.attempt` keys are ignored by the old code. Opt out of the pump step
only with `AIGENTRY_REPORT_PUMP=0` on the reconciler.

## Platforms

- The pump is plain Node + the Python registry + the telepty CLI on all of
  macOS, Linux and Windows. It does not use bash, curl, pmset or file modes as
  authority; the envelope challenge is the authority.
- macOS: the launchd reconciler runs it. Linux/Windows: no scheduler is
  installed; run `report-pump --loop 60` yourself.
- **Native Windows confined workers are unsupported** (dispatch refuses, exit
  78): there is no Windows sandbox yet, so there is no Windows outbox to read.
  A pump pass there refuses at the sealed-chain check
  (`chain_agent_binding_*`: the private-dir owner check has no uid on Windows).
  The outbox reader on its own (`readItem`) refuses with
  `nofollow_unsupported`. This is an open prerequisite, not a passed
  platform: nothing here claims the report path completes on every OS.
- Reporting is not unconditional. See the turn-end hook below for what is
  automatic and what is not.

## Turn-end hook (#1136): a status signal, not a report

New **claude** confined workers get a turn-end hook. Codex has none: it relies
only on the failure notices above.

- **Staging.** The sandbox stages `<attempt>/report-hook/turn-hook.mjs`
  (node built-ins only). The worker can read it but not write it, and its path
  and sha256 are sealed in the manifest. The pump flags a changed file as
  `hook_sha_mismatch`.
- **Settings.** Claude gets ONE host-generated inline `--settings`, with
  hooks for `UserPromptSubmit`, `Stop`, `StopFailure` and `SessionEnd`. Each
  runs `<node> <hook> <event> <outbox> <shared> <sid> <attempt>` with direct
  args and no shell. A caller's own `--settings` is still refused.
- **Binding.** A turn is bound to a request only when its prompt is exactly
  dispatch's `[context-ref] Read <shared>/<sha>.md …` line, the file's sha
  matches its name, and the ref's last lines are this sid/attempt's
  `REPORT_ENVELOPE`. Any other prompt starts an *unbound* turn.
- **Overlapping prompts.** If a second prompt arrives before the turn ends
  (queued, or after an interrupt), the turn's association becomes `unknown`.
  Nothing is guessed from mtime or "latest ref".
- **Output.** When the turn ends, the hook writes
  `<outbox>/<request>/TURN-<n>.md` (or `_unbound/TURN-<n>.md`). It never
  writes to stdout and always exits 0.
- **`TURN_ENDED_NO_REPORT`.** The pump sends this notice (ACK `seen`, same
  retry schedule) only when all of these hold:
  - it is the newest TURN of a request that is still `open` or
    `rework_requested`;
  - the pump captured no REPORT/HOLD that appeared during that turn.

  The notice is an **unauthenticated hook observation**: the model can write
  TURN files too. It never sets `done`, never becomes the final and never
  supersedes a REPORT. A formal REPORT and its review are still required.
- **`TURN_ENDED_UNBOUND`.** An unbound turn that ended with no new
  REPORT/HOLD while the attempt has open requests gets ONE informational
  notice. It needs no ACK and is never retried; deduplication is per attempt
  in `report-pump-health.json` `unbound_seen`, written before the send. A pump
  killed while sending never repeats it.
- **Ignored TURN files.** A malformed or wrongly-bound TURN file is listed
  under `ignored` in `report-status`. It is never captured or notified.

**Degraded hook.** Lock, state, item-write, stdin, session-id, argument and
64-TURN-limit failures leave a constant-code marker
`<outbox>/.hook-degraded-<code>`. The pump raises it once per open record as a
`hook_degraded` failure notice (ACK `seen`, durable backoff). It is not
success. If the outbox cannot be written at all, the hook prints only
`aigentry-turn-hook: DEGRADED_STORAGE_UNWRITABLE` to stderr. Then nothing
reaches the pump, and only `overdue`/`exited`/`gone` supervision remains.

**Native measurement (gate G0, builder).** One fresh confined claude worker
(`g01170atu-builder`, new task/sid/attempt) on the pinned claude 2.1.283,
macOS arm64, measured 2026-10-10. Two turns were measured (13:53–13:56 KST).
Neither was a queued-prompt test.

| Item | Status |
|---|---|
| inline `--settings` hooks under `--setting-sources user` | measured: they reached the hook |
| byte-exact `prompt` binding | measured on this context-ref prompt: `assoc=exact` |
| turn 1: `UserPromptSubmit` + `Stop`, no REPORT/HOLD | measured: `TURN-1`, `end=stop`, `assoc=exact`, `before=-`, `after=-` |
| turn 2: second idle dispatch, formal report | measured: the worker wrote `REPORT-1`; `Stop` wrote an exact TURN with `new_formal=[REPORT-1]` |
| pump capture | measured: the real reconciler/pump copied the first TURN and `REPORT-1` into the inbox |
| telepty notice | `gate_timeout`; the first status notice was seen `queued`; whether the formal notice was consumed is unknown. **Not** verified end-to-end delivery or receipt |
| review | the controller read the inbox bytes and ran `report-ack`: TURN `seen` kept `open`; `REPORT-1` `accepted` set `done`. A controller ACK after recovery, not a model reacting to the notice |
| protected-state canary | read and create both `EPERM`. Says nothing about broad VM/runtime security |
| `command`+`args` without a shell | **not traced**. The hook got its args; that does not prove there was no intermediate shell |
| queued-prompt `UserPromptSubmit`, `StopFailure`, `SessionEnd`, killed/abnormal end | **unverified** |
| Linux, native Windows, globally installed package | unverified or unsupported (see Platforms) |

Operator provenance (the controller's archive of that attempt, not something
you install or need):
`state/reports/2026-10-10-g01170atu-r1/turn-observation.json` (TURN-1),
`state/reports/2026-10-10-g01170atu-r1/READY.md`,
`state/reports/2026-10-10-g01170atu-r2/{REPORT.md,DENIAL.md}`. The second
TURN, capture, notice and ACK rows are controller records.

**Activation status.** Active only as local repository source/dist: reviewed,
built, tested with mocked inputs and Snyk-triaged. No daemon or root restart,
global install, commit or release. Rely on the hook only as far as the
measured rows go; for the unverified rows treat it as absent. This is not
full production acceptance, and reporting is still not unconditional: the
degraded-hook limits above apply. Workers spawned before activation have no
hook and cannot get one retroactively. A turn that is killed, or a hook that
never fires, falls back to the failure notices.
