# Request intake callers

This is a source checkpoint, not operational activation. The capture writer emits canonical
millisecond timestamps, while the current intake writer accepts only whole-second
`received_at` values. The pump preserves the timestamp verbatim and reports the writer's
refusal. Real capture-to-intake admission remains blocked pending the original core owner's
correction and the permanent real-caller regression. Never strip milliseconds to bypass it.

The controller may invoke `dispatch-tracker.sh intake-pump --once --capture-root ABSOLUTE`
with an explicitly configured `ORCHESTRATOR_SID`. The capture root must already exist and
pass the existing inventory's private-store checks. Nothing guesses or creates that store.
`DISPATCH_STATE_DIR`, `DISPATCH_REGISTRY_PY` and `TELEPTY` retain their existing controller
configuration roles; capture bytes cannot supply configuration or authority.

Every pass first enumerates complete metadata, rejects anomalies, duplicate identities,
unsupported durability and bounds, imports exact receipt identities idempotently, refreshes
the validated ledger, and diagnoses evidence/binding obligations before claiming a notice.
Equal bytes in separate receipts remain separate deliveries. Legacy identities remain
labelled. FIFO is received_at then ingress_id, not commit or execution order. The later core
timestamp correction must preserve chronological ordering across mixed timestamp formats.
Missing bindings are visible obligations; notices ask the controller to inspect them.
No caller answers, binds, starts, resumes, fails, finishes, cancels or prunes work.

`intake-status [--json]` performs a bounded unlocked read of intake.json without a registry
child, inventory, mkdir or health-log write. It returns 3 for pending obligations, 9 for an
unreadable/malformed/oversized ledger. Read-only observation is not a lock-consistent snapshot.
The pump also reports imported/replayed/refused counts, completeness, degraded reasons,
pending FIFO, legacy provenance and unresolved notice facts. Exit 0 means a bounded pass
completed; 3 means degraded/unknown/remaining work, 4 invocation or typed refusal, 9 storage
uncertainty. `complete` describes the inventory observation, not task completion.

The existing intake-notice writer rechecks explicit-null queued/unstarted eligibility under
its own lock. Claims use the immutable logical notice ID, predecessor, attempt, owner and
claim tuple. The external send occurs after the writer returns and releases that lock; the
result writer compares the exact tuple. Unknown/live claims are never recovered from PID
or elapsed-time guesses. Only a persisted definitive not_sent may retry after retry_at.
Attempt/event bounds remain the existing writer's 16/64 limits.

The transport calls telepty without a shell, with sender `intake-pump`, configured destination,
`--submit --no-submit-force --submit-retry 0`. The bundled CLI can exit zero for queued or
gated-timeout responses, and submit markers do not authenticate a semantic receiver ACK.
This adapter conservatively records unknown for every spawned transport outcome; only a
proven ENOENT/EACCES before spawn is not_sent. Bounded stdout/stderr/error/status observations
are hashed as evidence without printing their contents or persisting raw prompts/credentials.
Raw observations live only until the result hash is produced; no durable audit blob is claimed.
After an unknown send, further notices in that pass stop and later passes do not resend it.

`intake-ack` explicitly refuses `receiver_verification_unavailable` without reads or writes.
It has no tuple flags, environment bypass or invented verifier. A typed injected verifier
exists for later authenticated receiver integration and labelled simulations: the verified
event must match the current sent notice tuple and existing writer transition. ACK only
records notice evidence, never human authority or work completion. Receiver authentication,
deduplication, exactly-one logical delivery and semantic ACK remain OPEN.

Reconciler step 0b4 runs after report reconciliation and before peer audit only when not
dry-run, `AIGENTRY_INTAKE_PUMP=1`, and `AIGENTRY_CAPTURE_ROOT` is explicit and absolute.
It is default off. No settings are enabled by installing these source changes.

Each new registry/telepty direct child has a 10-second SIGKILL deadline and 1 MiB per stream,
shell false and an allowlisted environment. A pass shares a 60-second monotonic child budget,
at most 100 imports and 10 notices. More than 100 inventory items refuses the entire pass
before writes; the inventory itself enumerates at its existing 1000-item/4096-entry bounds.
Maximum pump child count is 132: 100 imports, two listings, and 10 claim/send/result triples.
The reconciler adds one direct tracker child with 60 seconds and 1 MiB output limits.
Registry shebang/interpreter and telepty daemon/terminal effects are not descendant-contained;
their descendant count is not certified. No instantaneous synchronous-I/O or whole-pass
wall-clock guarantee is claimed. Inventory filesystem awaits, status reads, verifier awaits,
spawn teardown and stream closure may outlast child deadlines.

The source-only author phase executes no tests, Python, transport or product runtime.
Independent security review, bounded real-caller baseline, core correction, unchanged retest,
U4–U6, effective-prompt replay, native/installed/interruption and release gates remain OPEN.
