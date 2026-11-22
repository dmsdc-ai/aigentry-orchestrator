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
`close`, `handled`, `resend` and `pump` (tasks 1291 and 1294), and the boot line for open records (SPEC §9.4).

The pump probes, re-sends the same bytes where SPEC §9.2 allows it, reminds you of open work, marks
records `stalled` when a human must decide, and applies retention. It runs automatically only where
something runs it: on macOS and Linux the reconciler runs `pump --once` in its act passes (step 0b4:
not in a dry run, not while a HITL pause stops acting, and only once the store directory exists); on
native Windows nothing does, so run `bin/controller-link.sh pump --loop 60` yourself in Git Bash.
`AIGENTRY_CONTROLLER_LINK_PUMP=0` turns it off (see below). Where the pump does not run, nothing probes
or re-sends on its own: run `bin/controller-link.sh probe --request <id>` yourself. Never re-run
`dispatch.sh`.

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
| `peers.<label>` | one entry per other machine; the key is its label | same pattern as `self.label`; `peers` may be `{}`. Do not use `con`, `prn`, `aux`, `nul`, `com0`–`com9` or `lpt0`–`lpt9`: the file accepts them, but they cannot name a directory on Windows, so on every platform the store refuses to create an inbox directory for one (the first message from that peer gets `RESULT=STORE_UNAVAILABLE`, exit 9). An inbox directory with such a name that an earlier version already made on macOS or Linux keeps working |
| `peers.<label>.target` | `<controller_sid>@<telepty peer name>` | exactly one `@`, at most 253 characters after it, no space or control character, not starting with `-`; the part after `@` is passed to telepty, which resolves it only against registered telepty peers. A local alias (`localhost`, `127.x.x.x`, `::1`, `0.0.0.0` and their URL spellings) names this machine: dispatch refuses it (exit 78) and every `controller-link` send refuses it too (exit 3 `STATE_INVALID`; `ingest` refuses that peer's envelopes as `PEER_UNKNOWN`). Other entries keep working |
| `peers.<label>.link` | turns the peer on | only the string `"v1"` turns it on. Missing, or any other string, keeps the entry but sends and accepts nothing |

The file is refused as a whole (`PEER_CONFIG_INVALID`) when: it is missing, not a regular file, larger
than 64 KiB, not UTF-8 JSON; a required key is missing (`link` may be absent: the peer is then off) or a
key is unknown at any level; `v` is not `1`; a label or sid
fails its pattern; a target is not `<sid>@<peer>`; `link` is not a string; or two peers share a target.
Duplicate JSON keys cannot be detected (the last one wins); do not write any. Write the file as valid
UTF-8: `controller-link` replaces an invalid byte while dispatch refuses the file, so the two could differ.

Also check the telepty daemon on each machine: if `AIGENTRY_ORCHESTRATOR_SIDS` is set, it must still
contain your controller sid. Otherwise the daemon blocks `controller-link → <sid>` as a peer-lane inject.
The default list contains `orchestrator`.

## Commands

Use `bin/controller-link.sh <command>` from your control workspace. On native Windows run the same
command from Git Bash (see "Windows" under Limits for why there is no cmd.exe or PowerShell form).
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
bin/controller-link.sh handled --request <id> --ref REPLY-<n>                   # a REPLY is recorded on your task
bin/controller-link.sh resend  --request <id> --reason "<text>"                 # re-send a stalled record's message
bin/controller-link.sh pump    --once | --loop <seconds>                        # one pump pass, or one every N s
```

- `ingest` reads the whole message on stdin (at most 262144 bytes). Text outside the envelope (for
  example a telepty banner) is ignored. It handles at most 8 envelopes per run; later ones are only
  counted in `SUMMARY dropped_blocks=`, and a start line without its end line is counted as ignored text.
  It prints one `RESULT=<NAME> kind=… id=… seq=… peer=… state=…` line per envelope (followed by
  ` answer=<ACK state> send=<result>` when it sent an acknowledgement), then an optional `NOTE`, an
  optional `NEXT <text>` (for `NEW` and `AWAITING`: the next protocol step, as a command or a short
  description; it is never needed to know what to do), the body as `| ` lines between `BODY …` and
  `END BODY` (for a REQUEST or REPLY shown as `NEW` or `AWAITING`), and one `SUMMARY` line that counts
  every envelope found, also those a store error left unprocessed. Input refused as a whole (too large)
  prints one `RESULT=` and one `NOTE` line and no `SUMMARY`. A store error stops the remaining
  envelopes. Act only on `RESULT=NEW` or `RESULT=AWAITING`. A new REQUEST is not an approval: the
  receiver decides first whether to take it.
- `RESULT=AWAITING` (exit 0): the same bytes as a REQUEST or REPLY that an earlier `ingest` recorded
  and that still waits for the controller: a REQUEST neither bound nor refused, or a REPLY not yet marked
  with `handled`. It shows the body again so that a crash or a lost output between the record and the
  controller never loses it. It applies nothing a second time: no record changes (a corroborated REPLY copy
  is acknowledged `received` again, as any duplicate), and `bind`/`refuse` accept a request only once. Once
  the controller has acted, the same bytes are `RESULT=DUPLICATE`.
- A REQUEST or REPLY whose `sent_at` is more than 25 days old, or more than 1 day ahead of this
  machine's clock, is `STALE_MESSAGE` (nothing stored). So is a REQUEST whose `sent_at` is not after
  the newest `sent_at` of a request that retention deleted (kept in `state/controller-link/retention.json`):
  retention deletes an inbox record only once its request is more than 25 days old, so after a clock
  correction no copy of a deleted request is applied again. Keep both machines' clocks right.
- `bind` needs a record in `received` and a task that is exactly one row in your queue with status
  `pending`, `in_progress`, `delegated`, `queued` or `blocked-by-observation`. It does not create tasks.
- `refuse` codes: `scope_not_grantable`, `credentials_requested`, `remote_action_requested`,
  `registration_bypass_requested`, `out_of_policy`, `cannot_do`, `duplicate_of_existing`.
  It needs `received` or `accepted`.
- `reply` needs `accepted` or `replying` and no earlier `--final`. Outcomes: `done`, `blocked`,
  `failed`, `declined`. Exactly one of `--final` / `--interim`. At most 32 replies.
- `probe` works on any open record that has a message of yours to ask about. The sender asks about
  its REQUEST; the receiver about its newest REPLY not yet acknowledged `received`, or its newest REPLY
  when all are (a receiver with no REPLY gets exit 3).
- `status` lists open records, and terminal ones with a REPLY not yet `handled`; `--request <id>` shows
  one request in any state. After a record's line it prints one `NEXT bin/controller-link.sh ingest <
  "<store root>/raw/<sha256>.env"  # …` line for each thing that waits for the controller: a REQUEST in
  `received`, a REPLY not yet `handled`, a stored copy the pump found corroborated. That command shows it
  (again). `--json` gives the same rows with an `awaiting` list of those commands.
- `handled --request <id> --ref REPLY-<n>` (sender): you have recorded that REPLY on your own task. It
  needs a REPLY that `ingest` stored and that is not yet handled (else exit 3); it sends nothing.
- `bind` and `refuse` keep exit 0, and `ingest` its result's exit, even when their acknowledgement could
  not be handed over; the line shows `send=<result>`, and the peer's `probe` gets the answer later. For
  `bind` and `refuse`, exit 0 reports the recorded action, not a confirmed hand-over. A REPLY for an
  unknown request is still answered (ACK `unknown`) when the audit shows it, and the exit is 4.
- If the store fails while `ingest` records an acknowledgement's send result, the envelope's own lines
  (including `RESULT=NEW` and its body) are still printed, the error goes to stderr, and the exit is 9.
  The `RESULT=NEW` stands: the record was written before the send. If the store fails while `bind`,
  `refuse`, `reply` or `probe` records its send result, the command exits 9 although its action is
  recorded: run `status --request <id>` before anything else, and never repeat `reply`.
- `resend` needs a `stalled` record that still has an unacknowledged message of yours (the sender's
  REQUEST, or the receiver's newest REPLY not acknowledged `received`), and a one-line `--reason`.
  It sends the stored bytes again.
- `pump` with `AIGENTRY_CONTROLLER_LINK_PUMP=0` prints that it is disabled and exits 0 without reading anything.

### Exit codes of `bin/dispatch.sh` with a `@` target

| Exit | Printed | Meaning |
|---|---|---|
| 0 | `OK peer request <id> to <target> consumption=<submit>` (stdout) | handed over to telepty; the task row's ledger is updated as for a local dispatch (best effort; not with `--no-task`) |
| 4 | `--ref required`, `PEER_FLAG_UNSUPPORTED`, `PEER_BODY_INVALID`, `PEER_BODY_TOO_LARGE`, `PEER_REF_PLACEHOLDER` | usage; nothing sent. The unchanged task-gate and input checks also exit 4 or 5 before this |
| 7 | `PEER_DELIVERY_UNKNOWN` | record kept; do not re-run dispatch; the pump reconciles it where it runs, else `probe` later |
| 8 | `PEER_REQUEST_DEDUPLICATED` | an open request to the same peer with the same task and body exists; its id is printed; nothing sent |
| 9 | `PEER_NOT_RECORDED` | store failure; nothing sent |
| 11 | `PEER_NOT_DELIVERED` | telepty refused before delivery; record kept; do not re-run dispatch; the pump re-sends where it runs |
| 78 | `PEER_TARGET_REFUSED`, `PEER_CONFIG_INVALID` | not a configured peer with `link:"v1"`, a local alias (this machine), or a bad peers file; the message names which; nothing sent |

A `--target` without `@` behaves exactly as before.

### Exit codes of `bin/controller-link.sh`

| Exit | Command | Codes | Meaning |
|---|---|---|---|
| 0 | all | `RESULT=NEW`, `AWAITING`, `ANSWERED`, `DUPLICATE`, `STALE`; `OK …`; `--help`; a `pump` turned off | done |
| 3 | bind, refuse, reply, status, probe, close, handled, resend | `TASK_UNKNOWN`, `TASK_AMBIGUOUS`, `TASK_NOT_DISPATCHABLE`, `STATE_INVALID` | refused; nothing changed |
| 3 | pump | `PUMP_ERROR …` or `PUMP_DEADLINE …` lines | at least one record failed, or the pass ran out of time; the rest waits for the next pass |
| 4 | ingest | `ENVELOPE_INVALID`, `COPY_MISMATCH`, `VERSION_UNSUPPORTED`, `NOT_FOR_THIS_CONTROLLER`, `PEER_UNKNOWN`, `UNKNOWN_REQUEST`, `STALE_MESSAGE`, `INPUT_TOO_LARGE` | refused; nothing stored |
| 4 | any | `USAGE`; reply also `PEER_BODY_INVALID`, `PEER_BODY_TOO_LARGE` | bad arguments or body; nothing changed |
| 5 | ingest | `RESULT=UNVERIFIED`, `RESULT=CONFLICT` | stored; not actionable |
| 7 | reply, probe, resend | `PEER_DELIVERY_UNKNOWN` | record kept; do not re-run; `probe` later |
| 9 | any | `PEER_CONFIG_INVALID` (stderr, before any `RESULT=` line), `STORE_CORRUPT`, `STORE_UNAVAILABLE`, `LINK_CAPACITY` (also `RESULT=LINK_CAPACITY` for a probe not answered because 256 probes about unknown requests were answered in the last 60 s) | fail closed |
| 11 | reply, probe, resend | `PEER_NOT_DELIVERED` | record kept; do not re-run; `probe` later |
| 1 | pump | `pump pass failed: …` | unexpected failure of the pass |

With several envelopes in one `ingest`, the worst exit wins: 9, then 4, then 5, then 0. Each envelope
is handled on its own, so an earlier one may already be stored when a later one gives 4 or 9. A store
error stops the remaining envelopes. A REPLY for a request you have no record of is `UNKNOWN_REQUEST`
(exit 4); if your audit shows it, `ingest` still answers it with an ACK `unknown`. Without arguments the
command prints the usage and exits 4; `--help` exits 0. A missing or bad peers file makes every other
`controller-link` command exit 9 `PEER_CONFIG_INVALID` (including `ingest`), except a usage error the
argument parser finds first (an unknown command or flag, a flag without its value or given twice, any
`resend` or `pump` argument error: exit 4) and a `pump` pass turned off by
`AIGENTRY_CONTROLLER_LINK_PUMP=0` (exit 0). A missing required flag, a bad request id or a bad outcome
is found after the peers file is read, so with a bad peers file those give 9.

## Two-machine test (do it once in each direction)

Preconditions:

- Both machines run the release under test.
- telepty peers are registered both ways.
- `state/controller-peers.json` exists on both, each listing the other with `"link": "v1"`.
- Create one evidence folder per direction, for example `evidence/mac-to-linux/`.

Steps (Mac → Linux shown; then repeat Linux → Mac):

1. Sender: register a local test task. Write a short request in `spec.md`. Run
   `bin/dispatch.sh --target orchestrator@<peer> --ref spec.md --task <id>`.
   Save the command line, its stdout, stderr and exit code. The exit must be 0 with
   `OK peer request <id> to <target> consumption=<submit>` on stdout (any other exit is not a hand-over).
2. Receiver: watch the prompt arrive. Let the controller run `ingest` and decide by its own rules (with
   your approval where its policy asks for one) to take the test request. Then let it register its own
   task and `bind` it. Let it dispatch one trivial confined worker as it dispatches workers for its own
   tasks: `bin/dispatch.sh --ref <worker prompt> --task <its id>` plus the worker target or spawn options
   it always uses (for example `--target <worker sid>`, or `--spawn-and-dispatch` with its role options).
   When the worker's REPORT is accepted, let it run
   `bin/controller-link.sh reply --request <id> --outcome done --final --body-file <file>`.
3. Sender: let the controller `ingest` the acknowledgements and the REPLY, record the REPLY on its task
   and run `bin/controller-link.sh handled --request <id> --ref REPLY-1`.
4. Daemon restart test (needs the pump running on the sender): between steps 1 and 2, restart the RECEIVER's
   telepty daemon. Send a second request while the receiver daemon is stopped. Start it again after
   5 minutes.
5. Session restart test: after the receiver's `ingest` and before `bind`, restart the receiver
   controller with `bin/orchestrator-boot.sh`. The boot handoff should name the open record.
6. Duplicate test: on the sender, after `handled`, run `ingest` a second time on the saved copy of the
   prompt that carried the final REPLY, within 25 days of its `sent_at`. It must print
   `RESULT=DUPLICATE` (before `handled` it prints `RESULT=AWAITING` and the body again). (A final REPLY
   that the sender has acknowledged cannot be re-sent with `resend`: that command needs a `stalled`
   record with an unacknowledged message.)

Evidence to capture in each folder:

- On both machines: `telepty --version`, the orchestrator package version, and
  `shasum -a 256 dist/src/controller-link/*.js dist/src/dispatch/cli.js` (Linux: `sha256sum`).
- Both `controller-peers.json` files.
- The dispatch command line, its full stdout and stderr, and its exit code.
- `bin/controller-link.sh status --json` on both machines after each step.
- The raw envelope files `state/controller-link/raw/*.env` and their sha256. On the receiver, the
  matching rows of `telepty injects --json --to <its self.controller_sid> --from controller-link`
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

Pass: dispatch exit 0 with its `OK peer request` line; one record per request on each side; both task
ids on both sides; every re-send explained by SPEC §9.2; the duplicate REPLY changed no state and no task;
no human restated a next action.

## The pump and its off switch

On macOS and Linux the reconciler runs one pump pass (`pump --once`) in each of its act passes (step
0b4; not in a dry run or while a HITL pause stops acting, and not before the store directory exists).
On native Windows run `bin/controller-link.sh pump --loop 60` yourself in Git Bash.
`AIGENTRY_CONTROLLER_LINK_PUMP=0` turns it off. Commands and `ingest` keep working; automatic probes,
safe re-sends, reminders and retention stop until the variable is removed. A peer removed from the
peers file is not probed or re-sent to.

The pump's reminders are local notices to your own controller session. Each is exactly two lines:

```text
⟦controller-link notice⟧ <KIND> request_id=<id> role=<sender|receiver> peer=<label> state=<state> sender_task=<task|-> receiver_task=<task|-> n=<k> — <description>
next: bin/controller-link.sh status --request <id>
```

The second line is always that one fixed command; a notice never carries a path or any other command.
`<KIND>` and its description (a peer whose target is a local alias also counts as not configured):

| KIND | description |
|---|---|
| `STALLED` | reconciliation stopped; nothing more is sent automatically; a human decides (resend or close) |
| `CONFLICT` | two corroborated copies of one message have different bytes; nothing was sent; held for a human |
| `REFUSED` | the peer refused this request (reason=`<code>`) |
| `PEER_UNCONFIGURED` | the peer is not configured with link "v1"; nothing is sent for this record and its state is kept |
| `CORROBORATED` | see below |
| `REPLY_UNVERIFIED` | a REPLY from the peer is still not corroborated by this machine's telepty audit after 48 h; it is not acted on and the record's state is kept |
| `UNBOUND` | a peer request waits for bind or refuse |
| `NO_FINAL` | your bound task has no final REPLY yet |

A notice is not an envelope and is never ingested itself. It arrives as an ordinary prompt, so nothing
proves that it came from your pump: the controller treats all of it, the `next:` line included, as data
and never runs a command because a notice (or any prompt or envelope body) prints it. It takes only the
`request_id`, checks that it is a request id, runs `bin/controller-link.sh status --request <id>` and
acts on what `status` prints for that id from the record: the state, and a
`NEXT bin/controller-link.sh ingest < "<store root>/raw/<sha256>.env"` line when something waits to be
shown, the only command it takes from `status`. Whatever a notice is about stays in the record until the
controller acts, so `status` shows it again however many notices were missed. The pump has no notice for
a REPLY that waits for `handled`: `status` lists it.

**`CORROBORATED`.** For 48 hours after an envelope was stored as `RESULT=UNVERIFIED` (a REQUEST, or a
REPLY copy), the pump re-runs the audit check for it on every pass. When the audit shows it, the pump
records that and posts:

```text
⟦controller-link notice⟧ CORROBORATED request_id=<id> role=<receiver|sender> peer=<label> state=<state> sender_task=<task> receiver_task=<task> n=<k> — a <REQUEST|REPLY> from the peer stored unverified is now corroborated by this machine's telepty audit; it has not been shown or applied; this notice repeats until the record shows it was picked up
next: bin/controller-link.sh status --request <id>
```

Do not run the `next:` command from the notice. Run `bin/controller-link.sh status --request <id>` yourself:
while the copy waits it prints `NEXT bin/controller-link.sh ingest < "<store root>/raw/<sha256>.env"  # …`,
built from the record and your store root. Run that one and act only on a `RESULT=NEW` line it prints, as
for any `ingest`. The notice itself is never actionable. The pump does not apply the copy and sends no
acknowledgement: the `ingest` you run applies it, shows the body and sends the ACK `received` (a deviation
from SPEC §9.3, where the pump applied it). That `ingest` accepts the pump's recorded check of those exact
bytes as corroboration, so it applies the copy also after the audit row has rotated out of the 48-hour
query. The notice repeats every 2 hours until the record
shows the copy was picked up: the copy was applied, or the record was closed. A request still unverified 48
hours after it arrived becomes `stalled`; a copy the pump found corroborated still waits (`status` still
shows it) until you ingest it or close the record. A REPLY copy the audit never shows gets a daily
`REPLY_UNVERIFIED` notice instead. On native Windows run the same commands in Git Bash (PowerShell has no
`<` redirection). If `status` prints no such `NEXT` line, the copy no longer waits.

## Rollout order

1. Install the release with controller-link. On its own this changes nothing: without the peers file,
   `@` targets still exit 78 and the `controller-link` commands exit 9 `PEER_CONFIG_INVALID` (except
   `--help` and a pump turned off by `AIGENTRY_CONTROLLER_LINK_PUMP=0`, exit 0, and a usage error the
   argument parser finds first, exit 4). The reconciler's step 0b4 does nothing while there is no store.
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
  is 48 hours ago, or one day before the envelope's `sent_at` when that is later and not after now (one
  day is the clock difference between the two machines that this feature tolerates); a `sent_at` more
  than a day ahead falls back to the 48 hours. If 1000 or more matching injects arrived in that window,
  the row may not be among the 1000 returned. The envelope is then handled as not corroborated, never
  refused: a new REQUEST or REPLY is `RESULT=UNVERIFIED` (stored, not acted on), an ACK is
  `RESULT=UNVERIFIED` (not applied), and a copy of a message already recorded keeps its `DUPLICATE` or
  `AWAITING` result without an acknowledgement. For a REQUEST or REPLY, the pump's re-checks during the
  next 48 hours (each one query of the last 48 hours, without the `sent_at` bound) or a later `ingest`
  of the same copy can still find it. If the peer's clock is more than one day ahead of yours, its
  REQUESTs and REPLYs are `STALE_MESSAGE`; its acknowledgements are still checked against the last 48
  hours: keep both clocks right.
- **One acknowledgement may be STALE after a probe of an unknown request.** If your probe reaches the peer before
  the request does, the peer has no record and answers ACK `unknown` with sequence 1. The pump then re-sends the
  request once, as it must. The peer's first real acknowledgement (`received`) also carries sequence 1, so `ingest`
  prints `RESULT=STALE` for it. The record then moves with the peer's next acknowledgement (`accepted`,
  sequence 2) or its answer to the pump's next probe; this costs one extra probe once that answer arrives. If
  no further answer ever arrives, the pump keeps probing and finally marks the record `stalled` for a human.
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
- **Windows.** On native Windows run every command as `bin/controller-link.sh <command>` from Git Bash
  (Git for Windows, as every other `bin/*.sh`; see the README "Platforms" section), in the control
  workspace that `init` made. The workspace has no `dist/`: the shim finds the compiled code through the
  `aigentry-orchestrator` command on `PATH` (`bin/lib/node-shim.sh`) and sets `AIGENTRY_SHIM_SCRIPT_DIR`,
  so the command uses the workspace's `state/` (peers file, store, task queue). There is no cmd.exe or
  PowerShell form: `node <package>/dist/src/controller-link/cli.js` run by hand uses the PACKAGE's
  `state/` instead of the workspace's, and PowerShell has no `<` redirection. Nothing here has been run
  on Windows. Known gaps: file modes are not checked (POSIX uses 0700 directories and 0600 files); there
  is no directory fsync; the store lock needs a volume with hard links (NTFS, not exFAT or some network
  shares); if `telepty` resolves to a `.cmd` shim, Windows runs it through `cmd.exe`, which may cut the
  envelope at its first line break, so sending from Windows may end as an unknown or failed delivery that
  the receiver cannot ingest (nothing is applied; the pump's probes then show it); no service runs the
  pump: run `bin/controller-link.sh pump --loop 60` in Git Bash yourself. Peer labels that are Windows
  device names (`con`, `nul`, `com1`, …) get no new inbox directory on any platform. A Windows controller
  cannot start confined workers (README); it can still take a request it does itself, `bind` it and
  `reply` with any outcome. A `reply` needs a `bind` first, so decline a request you have not bound with
  `refuse` (for example `cannot_do`).
