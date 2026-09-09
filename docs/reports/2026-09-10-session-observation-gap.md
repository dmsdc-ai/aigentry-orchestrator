# Session observation gap: task #751

Analyst: dg751-analyst. Measurement date: 2026-09-10 KST;
metadata clock sample: 2026-09-09T20:25:39Z. Report only; parent incomplete.

## Finding and evidence limits

Three observations do not establish one incident root cause. Source establishes
loss of screen history on restoration, loss of terminal-state semantics in
`read-screen`, and overly strong helper verification from screen tokens.
Existing logs independently establish a daemon restoration/re-registration
sequence. They do not establish its initiator or explain exactly where qc's
original input failed to enter the model's context. No new reproduction ran.

Evidence labels below: **S** = inspected source/data; **O** = preserved observation
in the authorized dispatch context, not independently repeated here;
**H** = hypothesis requiring the tester's isolated reproduction.
Context source: `~/.telepty/shared/c468c27c59306c4c7af300f9c6bab032dae361ef5aaec2095eb91f92e2b8bb82.md`.
Task notes are historical claims, not source authority. Prompt bodies omitted.

## Currentness

- Target branch `evidence/751-session-observation` began clean at
  `d2dad6cfa44ee651e9fb441f25af3d21570a37b9`; orchestrator main had that same HEAD.
  Main has staged dispatch documents, modified queue and untracked files;
  those were left untouched. Only this report is owned by this task.
- `command -v telepty` resolves through the Node v20.20.0 bin symlink to
  `~/.nvm/versions/node/v20.20.0/lib/node_modules/@dmsdc-ai/aigentry-telepty/cli.js`.
  Installed and sibling package versions are both `0.8.3`.
  Sibling HEAD: `997ea7c7d98b1dbc420e2e6de95d455a150e1b2c`.
  All 312 sibling-tracked files also present in the installed package are
  byte-identical; no tracked sibling diff. Untracked sibling reports were not edited.
  This is content correspondence, not a claim that npm records an installed git SHA.
- Installed `cli.js` SHA256:
  `7bd030dd714fb4b34a35aecbd2264337d62cd6cb8fb71d9ed109195e617c5911`;
  installed `daemon.js` SHA256:
  `a99e58872ed4d969f23d25bce6abf97eb6d01691657dd892699d6a591e0464ae`.
- Orchestrator main/target probe, verifier, policy, dispatch and tracker sources
  match. Main's existing `dist/src/dispatch/cli.js` also contains the same
  probe call, delivery predicate and write/readback handling; tracker dist
  calls the same probe. `bin/dispatch.sh` and `bin/dispatch-tracker.sh` resolve
  through `bin/lib/node-shim.sh` to adjacent dist when available.
  Prior helper environment overrides and resident process module hashes were
  not captured, so on-disk currentness is not proof of incident-time residency.
- Read-only lsof now shows node PID 64913 listening on `127.0.0.1:3848`.
  No session-list/read-screen command was used: those can auto-start a daemon.

## Actual producer and readers (S)

Telepty paths here refer to the matched installed/sibling source above.

1. `cli.js:2797` `relayPtyOutput` writes title-rewritten PTY bytes to the native
   terminal, independently sending original bytes over owner WS or holding them
   while disconnected. Thus cmux renders VT state independently of daemon capture.
2. `cli.js:2468–2495,2551–2567`: bounded 256K-character pre-connect hold flushes
   on WS open, then readiness can be re-sent. Successfully flushed bytes are
   discarded from the hold. There is no historical replay or reconnect resize.
3. `daemon.js:3129` appends received output into a roughly 200K-character ring
   and increments `outputRingTotalBytes`. `src/session-store/persistence.js`
   serializes metadata, not the ring; restoration creates `outputRing: []`.
4. `daemon.js:5119` `/api/sessions/:id/screen` concatenates the ring, applies
   `src/screen-ansi.js` unless raw, splits on newline, tails, then trims.
   This is not a VT emulator: cursor-up/erase/position commands are stripped,
   carriage returns deleted, cursor-forward translated to spaces. Redraw history
   can become one line; erased historical working text remains searchable.
5. `cli.js:3063` read-screen fetches that endpoint, not cmux. Empty endpoint
   content prints `(empty screen)`; failed lookup/non-OK exits 1, while the catch
   branch logs an error without explicitly setting a nonzero exit code.
   Empty stdout, literal empty-screen sentinel and empty HTTP screen differ.
6. `bin/session-probe.py`: `nonempty_lines`/`tail` count newline-delimited lines,
   not terminal rows. `classify_surface` checks WORKING before welcome/idle.
   WORKING includes static glyphs such as `⏺`. `activity=moving` means one
   matching surface token; it does not compare samples or an inject watermark.
7. `ready_by_screen` rejects HARD_NEG in last three lines, otherwise accepts a
   prompt anywhere in last twenty before testing banner. WORKING and HARD_NEG
   differ. Hence ready=false/moving and ready=true/moving are both possible
   for static historical text; neither proves a fresh task turn.
8. `observe` combines screen readiness with alive/transport/bootstrap readiness.
   Its `verify_started` uses transport/bootstrap plus surface/activity problems,
   not `screen_ready`, a task ref or an inject ID. `bin/policy.py:129` accepts
   that boolean; `bin/dispatch-verify.sh` prints “Started as intended.” after
   one settled probe. `src/tracker/cli.ts:795` feeds captured screen to the same
   probe; tracker_class independently prioritizes welcome before active.
9. `src/dispatch/cli.ts:234,927,1091` polls probe.ready before begin-delivery
   and inject. After transport write, optional `verifyDelivered` reads screen;
   failed/empty stdout returns unknown (exit 7), preserving write_observed.
   `screenShowsDelivery:308` accepts any readable screen unless a Try placeholder
   is present without ref-first-line echo. No-placeholder welcome, unrelated
   output and even `(empty screen)` pass this predicate by inspection.
   It checks neither exact-ref consumption nor a fresh task turn. The subsequent
   started check is non-fatal and independently overstates screen evidence.

## Separated incident conclusions

### A: qw1136 idle native screen / empty capture

**O:** completed report and idle composer in cmux251; repeated empty telepty
screen, upstream_bytes=0 after reconnect, bridge_pty_bytes=1347128; continuation
timed out before inject. Redraw attempts did not recover it; artifact preserved.
**S:** `daemon.js:2292` upstream counts this daemon record's appended output;
bridge counter is cumulative PTY reads. A large bridge total and zero daemon
total alone do not prove current read failure: their lifetimes differ.
Metadata restoration plus silence can leave a connected record with no history.
**H:** that path explains A plausibly, but no preserved raw-ring/heartbeat delta
or owner-generation trace isolates it from a relay/record replacement fault.
The installed OSC stripper already has the bounded #1099 matcher; do not assert
the old greedy-OSC failure. With a correctly sampled zero append count, stripping
alone cannot explain missing upstream bytes. Need same-epoch raw/clean comparison.
Historical #804's hold-and-flush fix is present (`ac065469e3ca…` inspected);
it buffers newly emitted disconnected output, not pre-disconnect screen history.

### B: qb1136/pd1148 consumption with DELIVERY_UNKNOWN

**O:** exact initial refs visibly consumed, helper read-screen rc1/empty during
availability gap; launchctl observation showed active0/spawn failed/signal15.
**S:** limited daemon-log suffix contains both original INJECT/SUBMIT records,
then “Starting telepty daemon”, restored qb/pd records, listener announcement,
stale cleanup and new owner registrations. New epochs differ from initial ones.
This corroborates restoration/re-registration, not its cause or elapsed duration.
The log lacks UTC timestamps on these lines; “2027s” cleanup ages are not a
measured outage duration. No conclusion about sleep, clock jump, restart caller
or signal sender is warranted. Helper exit 7 is conservative missing readback
evidence, compatible with actual consumption; it is not proof of failed input.
Owner: observation availability in telepty; retain helper unknown/dedup semantics.

### C and pd correction: historical activity and unproven consumption

**O:** qc helper printed VERIFIED, yet cmux256 later showed welcome-only;
original ref was explicitly denied by the worker after a distinct short query
arrived. Clean worktree alone would not prove non-consumption; the reply adds
task-specific negative evidence. pd correction failed before inject while its
one-line historical spinner caused ready=false/hard-negative and moving.
**S:** probe/verification mechanics above directly admit these contradictory
classifications. Daemon log records qc original write/SUBMIT and later query
write/SUBMIT; neither log entry proves the original ref entered context.
Current registry row `ee02d69a20c7499c93ed66d1a832b606` now has lifecycle=cleaned
(previous observation was delivery_attempt_started), transport=write_observed,
original inject ID `f91291e7-c8c1-4b31-a831-da4fc29c81b4`, outcome=unknown,
session_epoch=null. Cleanup did not establish task completion.
`bin/dispatch-registry.py:375` deduplicates write_observed before considering
unknown retry. `--retry-unknown` cannot authorize a duplicate in this case.
**H:** boot/welcome timing may explain lost original input, but a stale spinner
only explains why verification missed it. The exact loss stage remains unknown.
`daemon.js:1657–1682` classifies bootstrap via command identity;
`src/prompt-symbol-registry.js:278` matches command-token basenames, not launcher
contents. A guard worker-launcher.sh is unknown and gets generic_command_compat
ready=true. That flag is compatibility readiness, not CLI prompt/consumption proof.

## Historical attribution conflict

Task #960 says readiness adoption was fixed by `61179b2`. Inspected full SHA
`61179b24bcec039094cec5fad1f473edb3c2142b` belongs to telepty, titled update must
not claim success when daemon is dead; its files are cli.js, package.json and
update-failure-exit-61 test. It is absent from orchestrator history here.
The current probe DOES read bootstrap.ready, but ANDs it with screen_ready for
every CLI: partial bootstrap guard use, not authoritative readiness adoption.
Do not treat the note as proof of adoption or propose rolling back #960.
HOLD sent upstream; orchestrator verified the attribution conflict and is
recording/reopening #960. Tester ownership follows report review; no new policy
decision is needed to complete this diagnosis.

## Exact isolated tester proposals (not executed)

Use disposable fake CLI/PTY, private daemon port/state and helper seams; no model
calls, production sessions or terminal switch. Preserve raw byte fixtures and
native rendered comparison, monotonic order, epoch and inject ID in each case.

| Case; minimal owner/files | Isolated reproduction and expected before → after bounded correction |
| --- | --- |
| A quiet restoration; telepty `cli.js`, `src/session-store/persistence.js`, `daemon.js` screen endpoint | Fake CLI emits `READY-A\r\n› ` once while connected, then remains completely silent. Restart only fixture daemon and reconnect same bridge. Before: native screen persists, restored ring empty/zero; helper cannot prove ready. After: observation adapter supplies authoritative preserved/current state or explicitly reports unavailable; never invent readiness. Control: emit `GAP-B` while disconnected; existing #804 must flush it once in order. No resize/new-output requirement for the silent case. |
| Historical redraw; telepty `src/screen-ansi.js`/screen endpoint, orchestrator `bin/session-probe.py` | Feed `Thinking…\r\n› `, then VT clear/home and `Welcome back\r\n› ` with no further output. Native final state is idle welcome; stripped history still includes Thinking. Repeat identical observation twice. Before: hard-negative and moving can coexist. Second fixture substitutes `⏺ old report` for Thinking: ready=true/moving can coexist. After: stale text cannot establish current activity; keep original history inspectable with provenance. Controls: genuine current spinner, trust modal, blank/unavailable capture and completed idle composer must remain distinguishable. |
| Consumption false positive; orchestrator `src/dispatch/cli.ts`, `bin/session-probe.py`, `bin/dispatch-verify.sh` | Stub telepty with CONNECTED/ready metadata, successful write ID and unchanged no-placeholder welcome plus old working glyph; fake consumer records zero accepted refs. Run helper in private registry. Before: delivery predicate and started probe can pass. After: no claim of task consumption without fresh ref/epoch-scoped evidence. Controls: only sentinel `(empty screen)` must not verify delivery; old matching ref echo, unrelated fresh output and a queued ref must not prove consumption; genuinely accepted exact ref must remain observable. |
| Launcher boot race; telepty `src/prompt-symbol-registry.js`, `daemon.js` bootstrap; orchestrator readiness adapter | Fake launcher-named CLI draws welcome/prompt before an explicit input-accept latch and drops input until latch opens. Compare direct known CLI name and launcher path with identical stream. Before: generic bootstrap ready can precede acceptance and stale token can bless write. After: unsupported identity stays qualified/unknown until authoritative readiness; transport write alone never upgrades to consumption. Controls: known CLI with ready=false stays blocked; legitimate idle-ready CLI is accepted without requiring it already be working. |
| B readback gap; telepty availability/CLI read-screen, orchestrator `src/dispatch/cli.ts`, `bin/dispatch-registry.py` | Fake CLI accepts one exact ref and records count=1; interrupt only fixture observation endpoint between successful write and readback. Before and after: helper returns delivery unknown, registry keeps write_observed, same-ref retry is refused. Restore endpoint and correlate preserved ref/epoch evidence without reinjection. Controls: readback refusal vs empty valid response, no write vs actual write, and changed epoch stay distinct. This reproduces mismatch semantics, not the production restart trigger. |

No always-ready fallback, longer polling timeout, deletion of historical evidence
or idle-case avoidance qualifies as a fix. Tester first establishes failing
assertions plus passing controls; orchestrator approves bounded owner spec;
coder fixes only the established mechanism. Restart attribution needs existing
supervisor/host evidence with measured clock provenance, not a guessed cause.

Validation: source/data comparisons and report diff only. No code, build, tests,
model calls, new runtime fault, daemon/session restart or worker injection.
Snyk N/A: report-only. Outstanding: isolated reproductions, incident-time capture
provenance, original qc input loss stage and B restart initiator. Parent incomplete.
