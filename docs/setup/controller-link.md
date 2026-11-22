# Controller link — requests between two machines' controllers (task 1291)

## What it is

- One controller sends a request to the controller on another machine with `bin/dispatch.sh`.
- The request travels as one fixed-format envelope inside a normal `telepty inject`. telepty is not changed.
- Each side keeps plain-file records in `state/controller-link/`. Every message has a request id and is applied once.
- The receiving controller runs `bin/controller-link.sh ingest`, registers its own task, and answers with `bind`, `refuse` or `reply`.
- A request carries no authority. The receiver decides what to do, with its own task and its own confined workers.

## What this release contains

Task 1291 ships the dispatch peer path, `ingest`, `bind`, `refuse`, `reply`, `status`, `probe` and `close`.
The boot line for open records (task 1294, SPEC §9.4) is also in this snapshot.

Task 1294's pump is NOT in this snapshot. So, for now:

- Nothing probes or re-sends on its own. Run `bin/controller-link.sh probe --request <id>` yourself.
- There is no `resend` and no `pump` command, and no record ever becomes `stalled`. `close` only works on
  `stalled`, so it cannot be used yet.
- `dispatch.sh` exit 7 and 11 print "the pump reconciles this automatically". Until 1294 ships that is
  not true: run `probe` instead. Never re-run `dispatch.sh`.

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
| `peers.<label>` | one entry per other machine; the key is its label | same pattern as `self.label`; `peers` may be `{}` |
| `peers.<label>.target` | `<controller_sid>@<telepty peer name>` | exactly one `@`; the part after `@` is passed to telepty, which resolves it only against registered telepty peers |
| `peers.<label>.link` | turns the peer on | only the string `"v1"` turns it on. Missing, or any other string, keeps the entry but sends and accepts nothing |

The file is refused as a whole (`PEER_CONFIG_INVALID`) when: it is missing, not a regular file, larger
than 64 KiB, not UTF-8 JSON; a key is missing or unknown at any level; `v` is not `1`; a label or sid
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
```

- `ingest` reads the whole message on stdin (at most 262144 bytes). Text outside the envelope (for
  example a telepty banner) is ignored. It prints one `RESULT=<NAME> kind=… id=… seq=… peer=… state=…`
  line per envelope, then `NOTE`, `NEXT <command>` (only for `NEW`), the body as `| ` lines between
  `BODY …` and `END BODY` (only for a new REQUEST or REPLY), and one `SUMMARY` line. Act only on `RESULT=NEW`.
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
  the line shows `send=<result>`, and the peer's `probe` gets the answer later.

### Exit codes of `bin/dispatch.sh` with a `@` target

| Exit | Printed | Meaning |
|---|---|---|
| 0 | `OK peer request <id> to <target> consumption=<submit>` (stdout) | handed over to telepty; task row ledgered |
| 4 | `PEER_FLAG_UNSUPPORTED`, `PEER_BODY_INVALID`, `PEER_BODY_TOO_LARGE`, `PEER_REF_PLACEHOLDER` | usage; nothing sent. The unchanged task-gate and input checks also exit 4 or 5 before this |
| 7 | `PEER_DELIVERY_UNKNOWN` | record kept; do not re-run dispatch; `probe` later |
| 8 | `PEER_REQUEST_DEDUPLICATED` | an open request with the same task and body exists; its id is printed; nothing sent |
| 9 | `PEER_NOT_RECORDED` | store failure; nothing sent |
| 11 | `PEER_NOT_DELIVERED` | telepty refused before delivery; record kept; do not re-run dispatch |
| 78 | `PEER_TARGET_REFUSED`, `PEER_CONFIG_INVALID` | not a configured peer with `link:"v1"`, or a bad peers file; nothing sent |

A `--target` without `@` behaves exactly as before.

### Exit codes of `bin/controller-link.sh`

| Exit | Command | Codes | Meaning |
|---|---|---|---|
| 0 | all | `RESULT=NEW`, `ANSWERED`, `DUPLICATE`, `STALE`; `OK …` | done |
| 3 | bind, refuse, reply, status, probe, close | `TASK_UNKNOWN`, `TASK_AMBIGUOUS`, `TASK_NOT_DISPATCHABLE`, `STATE_INVALID` | refused; nothing changed |
| 4 | ingest | `ENVELOPE_INVALID`, `COPY_MISMATCH`, `VERSION_UNSUPPORTED`, `NOT_FOR_THIS_CONTROLLER`, `PEER_UNKNOWN`, `UNKNOWN_REQUEST`, `STALE_MESSAGE`, `INPUT_TOO_LARGE` | refused; nothing stored |
| 4 | any | `USAGE`; reply also `PEER_BODY_INVALID`, `PEER_BODY_TOO_LARGE` | bad arguments or body; nothing changed |
| 5 | ingest | `RESULT=UNVERIFIED`, `RESULT=CONFLICT` | stored; not actionable |
| 7 | reply, probe | `PEER_DELIVERY_UNKNOWN` | record kept; do not re-run; `probe` later |
| 9 | any | `PEER_CONFIG_INVALID`, `STORE_CORRUPT`, `STORE_UNAVAILABLE`, `LINK_CAPACITY` | fail closed |
| 11 | reply, probe | `PEER_NOT_DELIVERED` | record kept; do not re-run; `probe` later |

With several envelopes in one `ingest`, the worst exit wins: 9, then 4, then 5, then 0. A store error
stops the remaining envelopes. Without arguments the command prints the usage and exits 4.
A missing or bad peers file makes every `controller-link` command exit 9 `PEER_CONFIG_INVALID`
(including `ingest`).

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
2. Receiver: watch the prompt arrive. Let the controller run `ingest`, register its own task and
   `bind` it. Let it dispatch one trivial confined worker with its own `bin/dispatch.sh --task <its id>`.
   When the worker's REPORT is accepted, let it run `reply --outcome done --final --body-file <file>`.
3. Sender: let the controller `ingest` the acknowledgements and the REPLY.
4. Daemon restart test (needs the task 1294 pump): between steps 1 and 2, restart the RECEIVER's
   telepty daemon. Send a second request while the receiver daemon is stopped. Start it again after
   5 minutes.
5. Session restart test: after the receiver's `ingest` and before `bind`, restart the receiver
   controller with `bin/orchestrator-boot.sh`. The boot handoff should name the open record.
6. Duplicate test (needs the task 1294 `resend` command): with
   `resend --reason "manual duplicate test"`, or from `stalled`, re-send the final REPLY once.

With task 1291 alone, run steps 1–3 and 5. Steps 4 and 6 wait for task 1294.

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
- Reconciler log lines of step 0b4 around the restart tests (task 1294).
- Step 4: the sender record's attempts (`refused_definite` or `unknown`, then the probe or re-send),
  showing that no human re-sent anything.
- Step 5: the boot log's handoff line naming the open record and its next action.
- Step 6: the second `ingest` printing `RESULT=DUPLICATE`, and the sender record unchanged.

Pass: no exit 78; one record per request on each side; both task ids on both sides; every re-send
explained by SPEC §9.2; the duplicate REPLY changed nothing; no human restated a next action.

## The pump and its off switch (task 1294)

The pump is not in this snapshot. When task 1294 is installed, the reconciler runs it on every pass,
and `AIGENTRY_CONTROLLER_LINK_PUMP=0` turns it off. Commands and `ingest` keep working; automatic
probes and safe re-sends stop until the variable is removed.

## Rollout order

1. Install the release with controller-link. On its own this changes nothing: without the peers file,
   `@` targets still exit 78 and every `controller-link` command exits 9 `PEER_CONFIG_INVALID`.
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
  `ingest` only confirms that this machine's telepty audit saw those exact bytes arrive cross-host
  from `controller-link`.
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
  fsync. No service runs the pump; once task 1294 is installed it must be run with `--loop` by hand.
  A Windows controller cannot start confined workers, so as a receiver it can only `refuse` or
  reply `declined`. Not verified on Windows.
