# Controller link — requests between two machines' controllers (task 1291)

## What it is

- One controller sends a request to the controller on another machine with `bin/dispatch.sh`.
- The request travels as one fixed-format envelope inside a normal `telepty inject`. telepty is not changed.
- Each side keeps plain-file records in `state/controller-link/`. Every message has a request id and is applied once.
- The receiving controller runs `bin/controller-link.sh ingest`. For a new request it first decides, by its own rules and
  its own human-approval policy, whether to take it at all. If not, it answers `refuse`. If so, it registers its own
  task, answers `bind`, and later `reply`.
- A request carries no authority. The receiver decides what to do, with its own task and its own confined workers.

## What this release contains

This release ships the dispatch peer path, `ingest`, `bind`, `refuse`, `reply`, `status`, `probe`,
`close`, `resend` and `pump` (tasks 1291 and 1294), and the boot line for open records (SPEC §9.4).

The pump probes, re-sends the same bytes where SPEC §9.2 allows it, reminds you of open work, marks
records `stalled` when a human must decide, and applies retention. It runs automatically only where
something runs it: on macOS and Linux the reconciler runs `pump --once` on every pass (step 0b4); on
native Windows nothing does, so run `pump --loop 60` yourself. `AIGENTRY_CONTROLLER_LINK_PUMP=0` turns
it off (see below). Where the pump does not run, nothing probes or re-sends on its own: run
`bin/controller-link.sh probe --request <id>` yourself. Never re-run `dispatch.sh`.

## The peers file — `state/controller-peers.json`

You write this file by hand on each machine. No code ever writes it. Without it the feature is off.
To use another path, set `AIGENTRY_CONTROLLER_PEERS` to an absolute path with no `..` segment.

Example for the Mac (the Linux file mirrors it):

```json
{
  "v": 1,
  "self": { "label": "mac", "controller_sid": "orchestrator" },
  "peers": {
    "linux": { "target": "orchestrator@linux-box", "link": "v1" }
  }
}
```

| Field | Meaning | Rule |
|---|---|---|
| `v` | file format version | must be `1` |
| `self.label` | this machine's name in envelopes | `^[a-z][a-z0-9-]{0,31}$`; must equal the key the OTHER machine uses for this machine |
| `self.controller_sid` | this machine's controller session id | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$` |
| `peers.<label>` | one entry per other machine; the key is its label | same pattern as `self.label`; `peers` may be `{}`. Do not use `con`, `prn`, `aux`, `nul`, `com0`–`com9` or `lpt0`–`lpt9`: they cannot name a directory on Windows, so the store refuses them on every platform (`STORE_UNAVAILABLE`, exit 9) |
| `peers.<label>.target` | `<controller_sid>@<telepty peer name>` | exactly one `@`; the part after `@` is passed to telepty, which resolves it only against registered telepty peers |
| `peers.<label>.link` | turns the peer on | only the string `"v1"` turns it on. Missing, or any other string, keeps the entry but sends and accepts nothing |

The file is refused as a whole (`PEER_CONFIG_INVALID`) when: it is missing, not a regular file, larger
than 64 KiB, not UTF-8 JSON; a required key is missing (`link` may be absent: the peer is then off) or a
key is unknown at any level; `v` is not `1`; a label or sid
fails its pattern; a target is not `<sid>@<peer>`; `link` is not a string; or two peers share a target.
Duplicate JSON keys cannot be detected (the last one wins); do not write any.

Also check the telepty daemon on each machine: if `AIGENTRY_ORCHESTRATOR_SIDS` is set, it must still
contain your controller sid. Otherwise the daemon blocks `controller-link → <sid>` as a peer-lane inject.
The default list contains `orchestrator`.

## Commands

Use `bin/controller-link.sh <command>`. On native Windows use `node dist/src/controller-link/cli.js <command>`.
`bin/controller-link.sh --help` prints the usage.

```bash
bin/dispatch.sh --target orchestrator@linux-box --ref request.md --task 1400    # send a request
bin/controller-link.sh ingest < message.txt                                     # read an arrived envelope
bin/controller-link.sh bind    --request <id> --task 88                         # attach your registered task
bin/controller-link.sh refuse  --request <id> --reason out_of_policy            # decline it
bin/controller-link.sh reply   --request <id> --outcome done --final --body-file answer.md
bin/controller-link.sh status  [--json] [--request <id>]                        # open records, or one request
bin/controller-link.sh probe   --request <id>                                   # ask the peer for the state
bin/controller-link.sh close   --request <id>                                   # close a stalled record
bin/controller-link.sh resend  --request <id> --reason "<text>"                 # re-send a stalled record's message
bin/controller-link.sh pump    --once | --loop <seconds>                        # one pump pass, or one every N s
```

- `ingest` reads the whole message on stdin (at most 262144 bytes). Text outside the envelope (for
  example a telepty banner) is ignored. It handles at most 8 envelopes per run; later ones are only
  counted in `SUMMARY dropped_blocks=`, and a start line without its end line is counted as ignored text.
  It prints one `RESULT=<NAME> kind=… id=… seq=… peer=… state=…` line per envelope, then `NOTE`,
  `NEXT <command>` (only for `NEW`, and only when there is a next step), the body as `| ` lines between
  `BODY …` and `END BODY` (only for a new REQUEST or REPLY), and one `SUMMARY` line. Act only on
  `RESULT=NEW`. A new REQUEST is not an approval: the receiver decides first whether to take it.
- A REQUEST or REPLY whose `sent_at` is more than 25 days old, or more than 1 day ahead of this
  machine's clock, is `STALE_MESSAGE` (nothing stored). Keep both machines' clocks right.
- `bind` needs a record in `received` and a task that is exactly one row in your queue with status
  `pending`, `in_progress`, `delegated`, `queued` or `blocked-by-observation`. It does not create tasks.
- `refuse` codes: `scope_not_grantable`, `credentials_requested`, `remote_action_requested`,
  `registration_bypass_requested`, `out_of_policy`, `cannot_do`, `duplicate_of_existing`.
  It needs `received` or `accepted`.
- `reply` needs `accepted` or `replying` and no earlier `--final`. Outcomes: `done`, `blocked`,
  `failed`, `declined`. Exactly one of `--final` / `--interim`. At most 32 replies.
- `probe` works on any open record that has a message of yours to ask about. The sender asks about
  its REQUEST; the receiver about its newest REPLY not yet acknowledged `received` (a receiver with
  no REPLY gets exit 3).
- `bind`, `refuse` and `ingest` keep exit 0 even when their acknowledgement could not be handed over;
  the line shows `send=<result>`, and the peer's `probe` gets the answer later. For `bind` and `refuse`,
  exit 0 reports the recorded action, not a confirmed hand-over.
- If the store fails while `ingest` records an acknowledgement's send result, the envelope's own lines
  (including `RESULT=NEW` and its body) are still printed, the error goes to stderr, and the exit is 9.
  The `RESULT=NEW` stands: the record was written before the send.
- `resend` needs a `stalled` record that still has an unacknowledged message of yours (the sender's
  REQUEST, or the receiver's newest REPLY not acknowledged `received`), and a one-line `--reason`.
  It sends the stored bytes again.
- `pump` with `AIGENTRY_CONTROLLER_LINK_PUMP=0` prints that it is disabled and exits 0 without reading anything.

### Exit codes of `bin/dispatch.sh` with a `@` target

| Exit | Printed | Meaning |
|---|---|---|
| 0 | `OK peer request <id> to <target> consumption=<submit>` (stdout) | handed over to telepty; the task row's ledger is updated as for a local dispatch (best effort; not with `--no-task`) |
| 4 | `PEER_FLAG_UNSUPPORTED`, `PEER_BODY_INVALID`, `PEER_BODY_TOO_LARGE`, `PEER_REF_PLACEHOLDER` | usage; nothing sent. The unchanged task-gate and input checks also exit 4 or 5 before this |
| 7 | `PEER_DELIVERY_UNKNOWN` | record kept; do not re-run dispatch; the pump reconciles it where it runs, else `probe` later |
| 8 | `PEER_REQUEST_DEDUPLICATED` | an open request to the same peer with the same task and body exists; its id is printed; nothing sent |
| 9 | `PEER_NOT_RECORDED` | store failure; nothing sent |
| 11 | `PEER_NOT_DELIVERED` | telepty refused before delivery; record kept; do not re-run dispatch; the pump re-sends where it runs |
| 78 | `PEER_TARGET_REFUSED`, `PEER_CONFIG_INVALID` | not a configured peer with `link:"v1"`, or a bad peers file; nothing sent |

A `--target` without `@` behaves exactly as before.

### Exit codes of `bin/controller-link.sh`

| Exit | Command | Codes | Meaning |
|---|---|---|---|
| 0 | all | `RESULT=NEW`, `ANSWERED`, `DUPLICATE`, `STALE`; `OK …` | done |
| 3 | bind, refuse, reply, status, probe, close, resend | `TASK_UNKNOWN`, `TASK_AMBIGUOUS`, `TASK_NOT_DISPATCHABLE`, `STATE_INVALID` | refused; nothing changed |
| 3 | pump | `PUMP_ERROR …` or `PUMP_DEADLINE …` lines | at least one record failed, or the pass ran out of time; the rest waits for the next pass |
| 4 | ingest | `ENVELOPE_INVALID`, `COPY_MISMATCH`, `VERSION_UNSUPPORTED`, `NOT_FOR_THIS_CONTROLLER`, `PEER_UNKNOWN`, `UNKNOWN_REQUEST`, `STALE_MESSAGE`, `INPUT_TOO_LARGE` | refused; nothing stored |
| 4 | any | `USAGE`; reply also `PEER_BODY_INVALID`, `PEER_BODY_TOO_LARGE` | bad arguments or body; nothing changed |
| 5 | ingest | `RESULT=UNVERIFIED`, `RESULT=CONFLICT` | stored; not actionable |
| 7 | reply, probe, resend | `PEER_DELIVERY_UNKNOWN` | record kept; do not re-run; `probe` later |
| 9 | any | `PEER_CONFIG_INVALID`, `STORE_CORRUPT`, `STORE_UNAVAILABLE`, `LINK_CAPACITY` | fail closed |
| 11 | reply, probe, resend | `PEER_NOT_DELIVERED` | record kept; do not re-run; `probe` later |
| 1 | pump | `pump pass failed: …` | unexpected failure of the pass |

With several envelopes in one `ingest`, the worst exit wins: 9, then 4, then 5, then 0. Each envelope
is handled on its own, so an earlier one may already be stored when a later one gives 4 or 9. A store
error stops the remaining envelopes. A REPLY for a request you have no record of is `UNKNOWN_REQUEST`
(exit 4); if your audit shows it, `ingest` still answers it with an ACK `unknown`. Without arguments the
command prints the usage and exits 4; `--help` exits 0. A missing or bad peers file makes every other
`controller-link` command exit 9 `PEER_CONFIG_INVALID` (including `ingest`), except a usage error
(exit 4, found first) and a `pump` pass turned off by `AIGENTRY_CONTROLLER_LINK_PUMP=0` (exit 0).

## Two-machine test (do it once in each direction)

Preconditions:

- Both machines run the release under test.
- telepty peers are registered both ways.
- `state/controller-peers.json` exists on both, each listing the other with `"link": "v1"`.
- Create one evidence folder per direction, for example `evidence/mac-to-linux/`.

Steps (Mac → Linux shown; then repeat Linux → Mac):

1. Sender: register a local test task. Write a short request in `spec.md`. Run
   `bin/dispatch.sh --target orchestrator@<peer> --ref spec.md --task <id>`.
   Save the command line, its stdout, stderr and exit code. The exit must not be 78.
2. Receiver: watch the prompt arrive. Let the controller run `ingest` and decide by its own rules (with
   your approval where its policy asks for one) to take the test request. Then let it register its own
   task and `bind` it. Let it dispatch one trivial confined worker with its own `bin/dispatch.sh --task <its id>`.
   When the worker's REPORT is accepted, let it run `reply --outcome done --final --body-file <file>`.
3. Sender: let the controller `ingest` the acknowledgements and the REPLY.
4. Daemon restart test (needs the pump running on the sender): between steps 1 and 2, restart the RECEIVER's
   telepty daemon. Send a second request while the receiver daemon is stopped. Start it again after
   5 minutes.
5. Session restart test: after the receiver's `ingest` and before `bind`, restart the receiver
   controller with `bin/orchestrator-boot.sh`. The boot handoff should name the open record.
6. Duplicate test: on the sender, run `ingest` a second time on the saved copy of the prompt that
   carried the final REPLY. It must print `RESULT=DUPLICATE`. (A final REPLY that the sender has
   acknowledged cannot be re-sent with `resend`: that command needs a `stalled` record with an
   unacknowledged message.)

Evidence to capture in each folder:

- On both machines: `telepty --version`, the orchestrator package version, and
  `shasum -a 256 dist/src/controller-link/*.js dist/src/dispatch/cli.js` (Linux: `sha256sum`).
- Both `controller-peers.json` files.
- The dispatch command line, its full stdout and stderr, and its exit code.
- `bin/controller-link.sh status --json` on both machines after each step.
- The raw envelope files `state/controller-link/raw/*.env` and their sha256. On the receiver, the
  matching rows of `telepty injects --json --to orchestrator --from controller-link`
  (same sha256, `claimed_cross_host: true`).
- Every `ingest` output line (`RESULT=…`), with its time.
- The receiver's own task row and the worker's dispatch registry record. They show a LOCAL confined
  worker under the receiver's task, and nothing spawned by the sender.
- Reconciler log lines of step 0b4 around the restart tests.
- Step 4: the sender record's attempts (`refused_definite` or `unknown`, then the probe or re-send),
  showing that no human re-sent anything.
- Step 5: the boot log's handoff line naming the open record and its next action.
- Step 6: the second `ingest` printing `RESULT=DUPLICATE`, and the sender record's state and REPLY entry
  unchanged (if the audit still shows the inject, `ingest` answers it with one more ACK `received`).

Pass: no exit 78; one record per request on each side; both task ids on both sides; every re-send
explained by SPEC §9.2; the duplicate REPLY changed no state and no task; no human restated a next action.

## The pump and its off switch

On macOS and Linux the reconciler runs one pump pass (`pump --once`) on every pass (step 0b4).
On native Windows run `pump --loop 60` yourself. `AIGENTRY_CONTROLLER_LINK_PUMP=0` turns it off.
Commands and `ingest` keep working; automatic probes, safe re-sends, reminders and retention stop
until the variable is removed. A peer removed from the peers file is not probed or re-sent to.

The pump's reminders are local notices to your own controller session. Each starts with
`⟦controller-link notice⟧ <KIND> request_id=<id> role=… peer=… state=… sender_task=… receiver_task=… n=<k> —`,
says what happened, and has a second line `next: <command>`. A notice is not an envelope and is never
ingested itself.

**`CORROBORATED`.** For 48 hours after an envelope was stored as `RESULT=UNVERIFIED` (a REQUEST, or a
REPLY copy), the pump re-runs the audit check for it on every pass. When the audit shows it, the pump
records that and posts:

```text
⟦controller-link notice⟧ CORROBORATED request_id=<id> role=<receiver|sender> peer=<label> state=<state> sender_task=<task> receiver_task=<task> n=<k> — a <REQUEST|REPLY> from peer <label> stored unverified is now corroborated by this machine's telepty audit; it has not been shown or applied; run the next command and act only on its RESULT=NEW
next: bin/controller-link.sh ingest < "<store root>/raw/<sha256>.env"
```

Run the `next:` command as printed and act only on a `RESULT=NEW` line it prints, as for any `ingest`.
The notice itself is never actionable. The pump does not apply the copy and sends no acknowledgement: the
`ingest` you run applies it, shows the body and sends the ACK `received` (a deviation from SPEC §9.3,
where the pump applied it). The notice repeats every 2 hours until that `ingest` applies the copy, for at
most 48 hours after the copy arrived; after that an unverified request becomes `stalled` (a `STALLED`
notice), and a REPLY copy gets a daily `REPLY_UNVERIFIED` notice. On native Windows run the same `ingest`
with `node dist/src/controller-link/cli.js` from cmd.exe or Git Bash: PowerShell has no `<` redirection.
If `next:` names `status` instead, the copy no longer waits.

## Rollout order

1. Install the release with controller-link. On its own this changes nothing: without the peers file,
   `@` targets still exit 78 and the `controller-link` commands exit 9 `PEER_CONFIG_INVALID`.
2. On the first upgraded machine (say Mac), write `controller-peers.json` with `self` and `"peers": {}`.
   Nothing can be sent yet.
3. Upgrade the second machine (Linux). Write its file with `self` and the Mac entry (`"link": "v1"`).
   Then add the Linux entry with `"link": "v1"` to the Mac file.
4. Restart each controller session at a convenient point, so it reads the new instruction section in
   `tooling/instructions/roles/orchestrator.md`. A controller that has not restarted still sees line 2
   of each envelope, which names the `ingest` command.
5. Run the two-machine test above in both directions before you rely on it.
6. Keep the hand-written notes until that test has passed once in each direction.

Rule: list a peer with `"link": "v1"` only when that peer already runs controller-link. Both
directions need both entries, because the receiver must be able to answer.

To turn the link off for one peer, remove its entry (or the whole file). Records stay on disk;
restoring the entry resumes them.

## Limits

- **No proof of the sending machine.** There is no signature. Anyone who holds the receiver daemon's
  token (the peer, or a process of the same user) can produce a message that passes every check.
  `ingest` only confirms that this machine's telepty audit, asked for injects to your controller sid
  `--from controller-link` in the last 48 hours, returns a row with the same sha256, `to` = your
  controller sid, the daemon's `claimed_cross_host` flag `true` and a delivery result `success` or
  `queued`. A row whose `claimed_from` is another string is not accepted; a row without one is (the
  query's `--from` filter is relied on). These are values the local daemon recorded and claimed. They
  do not prove which machine sent the bytes.
- **One audit query, at most 1000 rows.** `telepty injects` has no paging flag, so `ingest` makes one
  call: `telepty injects --json --to <your sid> --from controller-link --since <S> --limit 1000`. `<S>`
  is 48 hours ago, or one day before the envelope's `sent_at` when that is later (one day is the clock
  difference between the two machines that this feature tolerates). If 1000 or more matching injects
  arrived in that window, the row may not be among the 1000 returned. The message is then
  `RESULT=UNVERIFIED`, never refused: for a REQUEST or REPLY, the pump's re-checks during the next 48 hours (each one query of
  the last 48 hours, without the `sent_at` bound) or a later `ingest` of the same copy can still find
  it. If the peer's clock is more than one day ahead of yours, its acknowledgements are `UNVERIFIED` too
  (its REQUESTs and REPLYs are then already `STALE_MESSAGE`): keep both clocks right.
- **One acknowledgement may be STALE after a probe of an unknown request.** If your probe reaches the peer before
  the request does, the peer has no record and answers ACK `unknown` with sequence 1. The pump then re-sends the
  request once, as it must. The peer's first real acknowledgement (`received`) also carries sequence 1, so `ingest`
  prints `RESULT=STALE` for it. Nothing is lost: the peer's next acknowledgement (`accepted`, sequence 2) or the
  answer to the pump's next probe moves the record. At most this costs one extra probe.
- **Body at most 12 KiB.** A request or reply body is at most 12288 bytes after normalisation, and
  the whole envelope at most 16384 bytes. There is no splitting. Send a longer text by other means.
- **The receiving model must run `ingest`.** Nothing reads the envelope automatically. If the
  receiving controller does not run `ingest`, there is no record on that side. The instruction
  section tells it to; nothing enforces it.
- **The body is read by a model.** controller-link has no command that registers a task, dispatches,
  spawns or touches credentials. But if the receiving model follows a harmful body, nothing
  mechanical stops its own later actions.
- **Bodies are kept.** They sit in both controllers' transcripts and in `state/controller-link/raw/`
  on both machines.
- **Windows gaps.** `bin/controller-link.sh` is a bash shim; run `node dist/src/controller-link/cli.js`.
  File modes are not checked (POSIX uses 0700 directories and 0600 files). There is no directory
  fsync. No service runs the pump: run `bin/controller-link.sh pump --loop 60` by hand (as `node … pump --loop 60`).
  Peer labels that are Windows device names (`con`, `nul`, `com1`, …) are refused on every platform.
  A Windows controller cannot start confined workers, so as a receiver it can only `refuse` or
  reply `declined`. Not verified on Windows.
