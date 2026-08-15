# r3 — final gate on telepty 0.8.0 (`integ/trial-0.8.0` @ `9003c01`)

Reviewer: architect, session `r3c-final-gate`. READ-ONLY: no edits, no git writes, no daemon
control. Every repro below ran against a throwaway daemon (`PORT=0`, temp `HOME`).

**Verdict: SHIP-WITH-CUTS.** Two code findings and four documentation/artifact findings. None is a
security regression; F1 and F2 are both this release's own defect class committed inside the fixes,
which is what you asked me to look for.

---

## Suite, run here

`npm test`, flagless, 5 consecutive runs: **1086 tests / 1085 pass / 0 fail / 1 skip, exit 0** on
every one. Counts identical across all five.

On the tracked flake: I could not identify it — it did not reproduce in 5 runs. One piece of
evidence worth keeping: `# tests` was **exactly 1086 on all five runs**. If the
`test/enforce-submit-gate.test.js:157` `process.exit(0)` race had fired in any run, that child's
remaining subtests would have gone uncounted and the total would have dropped. It did not. So on
this host the race loses consistently; that says nothing about CI.

---

## Q1 — Does any output in this diff claim more than it measured?

Yes, in two places in code and two in prose.

### F1 — `capability.session_authentication: "observed"` is stamped on sessions that authenticated nothing. REPRODUCED.

`daemon.js:620-625` (bA, `fa803cf`):

```js
capability: {
  ...CAPABILITY_STAGE_A,
  ...(session && session.sessionEpoch
    ? { session_authentication: 'observed', session_authentication_reason: null }
    : {}),
},
```

The premise is written into the comment two lines up (`daemon.js:615-616`): *"records whose own
`session_epoch` … holds the epoch the session **PROVED** on its #815 handshake"*. That is true of
**one** of the three writers of `session.sessionEpoch`:

| writer | when | proof presented? |
|---|---|---|
| `src/transport/websocket.js:311` | owner claim with a verified bearer | **yes** |
| `daemon.js:3388` (`POST /api/sessions/register`) | at credential **issuance**, before anyone presents anything | **no** |
| `src/session-store/persistence.js:40-42, 110-112` | restored from disk on daemon start | **no** |

So the predicate measures *"this daemon minted or restored an epoch for this id"*, and the field
reports it as *"observed"* — the word this release reserves for a measurement.

**Failure scenario** (run, output verbatim):

1. `POST /api/sessions/register` with `delivery_type: "aterm"` and a `delivery_endpoint`. An aterm
   session never opens a WebSocket, so it can never reach `websocket.js:311`.
2. `POST /api/sessions/:id/inject` — no `x-telepty-session-token` on the request, no handshake, no
   bearer presented at any point in the session's life. Delivery succeeds (the sink received it).
3. `GET /api/inject-observations/<inject_id>`:

```
REGISTER status 201 epoch= 4gFaRwgXFPn6VzwXEaidRQ
INJECT status 200   delivery sink saw 1 delivery
OBSERVATION status 200
  session_epoch                            : 4gFaRwgXFPn6VzwXEaidRQ
  session_epoch_reason                     : null
  capability.session_authentication        : observed
  capability.session_authentication_reason : null
```

An orchestrator reading that capability block concludes the target session instance authenticated
itself. Nothing did. Before this change the field read `unavailable / no_815_epoch_fact`, which was
over-conservative but never wrong; the fix traded a stated gap for a stated measurement that was not
made. Same shape for every wrapped session in the window between `register` and the bridge's
credentialed `?owner=1` claim, and for every session restored across a daemon restart before its
bridge re-claims.

The test that covers it (`test/completion-unknown-observation-60.test.js:455-486`) hand-builds
`{ id: 'epoch-1', sessionEpoch: '1IWURA54wVOSjXlZmNVhsA' }` and names it "a proven epoch". It
asserts the premise instead of measuring it, which is why the suite is green.

**Cut:** either gate on a field that only `websocket.js:311` writes (e.g. record
`session.sessionEpochProvedAt` at the verified claim and key on that), or leave
`session_authentication` at `unavailable` and let `session_epoch` carry the epoch on its own — the
record already reports both fields separately.

### F2 — `abortTrackedInjection` closes the synchronous refusal only; an accepted-then-parked inject is audited `success` and stays `tracked` forever. REPRODUCED.

`abortTrackedInjection` (`daemon.js:654`) has exactly **one** call site: `daemon.js:4550`, the
synchronous `!delivery.success` arm of `POST /api/sessions/:id/inject`.

`deliverInjectionToSession` (`daemon.js:2734-2755`) has a second outcome that is neither success nor
refusal: the op is pushed onto the bootstrap / modal-park queue and the route is handed
`{success: true, strategy: 'bootstrap_queue', queued: true}`. Zero bytes have been written. The
route then audits `delivery_result: "success"` and leaves the write-ahead ledger record at
`tracking_state: "tracked"` / `inject_accepted`.

None of that queue's terminal outcomes reaches the abort:
`failBootstrapQueueOnTimeout` (`daemon.js:1924`), `drainBootstrapQueue`'s `bootstrap_queue_failed`
arm (`daemon.js:1851`), `flushModalParkQueue` (`daemon.js:2640`). Each emits a bus event and nothing
durable — which is the exact gap `websocket.js:346-349` argues against in this same release ("*the
bus event is push-only: a subscriber that was not listening at this instant, or a daemon restart,
would leave those injects with no record*").

**Failure scenario** (run, output verbatim). Register a wrapped session on a known AI CLI so it is
bootstrap-gated (`isBootstrapGatedSession`, `daemon.js:1464`), then inject:

```
HTTP  -> 200 {"success":true,"inject_id":"eb819f98-…","strategy":"bootstrap_queue",
              "submit":"queued","bootstrap_queued":true,"pending":1}
AUDIT -> [{ "source":"inject", "to":"gated-…", "delivery_result":"success",
            "inject_id":"eb819f98-…" }]
LEDGER (t+4s) -> tracking_state = tracked
                 observation = {"kind":"tracking_started","trigger":"inject_accepted","seq":1}
```

The audit log says **`success`** for a write that did not happen, and the ledger — the thing
`BOUNDARY.md:292-300` calls "what makes absence durable" and that `bin/dispatch-tracker.sh` polls —
says the dispatch is in flight. In this particular arrangement no timer is even armed:
`scheduleBootstrapPromptPoll` returns at `daemon.js:1976` when there is no open owner socket, so the
record can never move at any later time either.

The doc half of the same finding: `BOUNDARY.md:272-275` enumerates `delivery_result` as two values
with two meanings (`success` for HTTP/bus, `forwarded` for `ws-viewer`) and explains that they
"deliberately do not share a word". There is a third state — accepted-and-parked, nothing measured —
and it wears the strongest of the two words.

**Cut (small):** call `abortTrackedInjection` from the three terminal queue paths, and either add a
`queued` `delivery_result` or name the queued case in `BOUNDARY.md`'s `delivery_result` bullet.

### F5 — the door table excuses `submit-all`'s blast radius with a strategy no session can have.

`BOUNDARY.md:232-233` and `CHANGELOG.md:217-218`:

> "A session whose submit strategy is `osascript_cmd_enter` gets a GUI keystroke instead and touches
> no PTY at all."

`getSubmitStrategy` (`daemon.js:3818-3821`) is a constant function:

```js
const SUBMIT_STRATEGIES = { claude: 'pty_cr', gemini: 'pty_cr', codex: 'pty_cr' };
function getSubmitStrategy(command) {
  const base = command.split('/').pop().split(' ')[0];
  return SUBMIT_STRATEGIES[base] || 'pty_cr';
}
```

Every key maps to `'pty_cr'` and the fallback is `'pty_cr'`. It is the only caller of the
`osascript_cmd_enter` branch (`daemon.js:4410`), which is therefore unreachable, and
`submitViaOsascript` (`daemon.js:3867`) is dead. **Failure scenario:** an operator reads the
enumeration and concludes some `POST /api/sessions/submit-all` targets do not get a PTY write;
`runSubmitAll` (`daemon.js:4401-4421`) fires a bare CR at every session in the registry with a live
`ownerWs`/`ptyProcess`, with no exception. This is also the "field that can only ever hold one
value" you named: `results.successful[].strategy` in the `/submit-all` response is always `pty_cr`.

**Cut:** delete the clause from both docs, or replace it with "no session can currently be on that
strategy — `getSubmitStrategy` returns `pty_cr` for every command; the branch is dead". Per Rule 29
I am naming the dead code, not proposing its removal here.

### F6 — `scratchpad/README.md:14` quantifies coverage, and is false by one.

> "Every file below is **cited by name** from something that stays — an `EVIDENCE-*.md` write-up, a
> `test/*.test.js` provenance comment, `daemon.js`, `src/prompt-symbol-registry.js`, or
> `CHANGELOG.md`"

I re-enumerated all 21 tracked `scratchpad/` files. Twenty are cited. **`scratchpad/EVIDENCE-801.md`
is cited by nothing that stays** — the only occurrence of that filename anywhere in the repo is
line 1 of the file itself. (`EVIDENCE-730/737/760` are each cited from `test/` or `daemon.js` or
`src/prompt-symbol-registry.js`; `capture-801-api-error.js` and `e2e-801.js` are cited from
`CHANGELOG.md` and `test/idle-error-vs-complete-801.test.js`; the 801 write-up itself is not.)

The same README states the rule the cull used — "an uncited capture has lost the provenance that
made it evidence" — so the surviving file fails the rule the removals were made under. And the
sentence is a bare `Every`, in the release that made "enumerate, never quantify" a standing rule.
Its count of the removals ("Ten orphaned files — eight raw `evidence/*.txt` … plus `peek-752.js` and
`repro-737.sh`") I re-counted against the diff: **correct, 8 + 2 = 10.**

**Cut:** cite `EVIDENCE-801.md` from `test/idle-error-vs-complete-801.test.js` (which already cites
its two sibling artifacts), or drop the quantifier and list the exception.

---

## Q2 — The documentation, read as code

### The standing rule held, with one exception

I grepped every added line of `BOUNDARY.md`, `CHANGELOG.md`, `BUS_EVENT_SCHEMA.md`, the specs and
`scratchpad/README.md` for `both / all / every / each / none / complete` used as coverage claims.
Every hit is either a non-coverage use or is immediately followed by the enumeration. The rule is
even written into the artifacts themselves (`BOUNDARY.md:265-268`, `BUS_EVENT_SCHEMA.md:296-299`).
The one exception is **F6** above.

### My independent count of the PTY write doors

Measured on `9003c01` by tracing every path that can put bytes (or a CR) into a session's input
stream, not by reading the table. **Result: 6 recorded, 4 unrecorded routes in 3 named groups — the
table is correct.**

**Recorded** (7 `auditAppend` call sites, 6 doors):

| # | door | `source` | audit site |
|---|---|---|---|
| 1 | `POST /api/sessions/:id/inject` | `inject` | `daemon.js:4471` (blocked), `:4537` (failed), `:4564` (success) |
| 2 | `POST /api/sessions/multicast/inject` | `multicast` | `auditMulticastTarget` `daemon.js:3737`; `rejectPeerLaneFanout` `:3655` |
| 3 | `POST /api/sessions/broadcast/inject` | `broadcast` | same two |
| 4 | viewer WS `{type:'input'}` → **wrapped** (owner socket) | `ws-viewer` | `authorizeViewerInject` `daemon.js:4713`; deliverer `websocket.js:112` |
| 5 | viewer WS `{type:'input'}` → **spawned** (`ptyProcess.write`) | `ws-viewer` | same gate; deliverer `websocket.js:114` |
| 6 | bus `turn_request` / `deliberation_route_turn` auto-route | `bus` | `auditBusWrite` `daemon.js:5140` |

**Not recorded:**

| # | route | why |
|---|---|---|
| 7 | `POST /api/sessions/:id/submit` | bare `\r` via `terminalLevelSubmit` → `submitViaPty` (`daemon.js:3823`) |
| 8 | `POST /api/sessions/submit-all` | same CR across `Object.entries(sessions)` (`runSubmitAll` `:4401`) |
| 9 | viewer WS `{type:'resize'}`, both session types | `websocket.js:512-529`, no bytes into the input stream |
| 10 | `task_completion_unknown` text into a dispatch's SOURCE session | `recordObservation` → `_deliver(..., {source:'auto_report'})` `daemon.js:814` |

One nuance the table does not carry, offered as an improvement rather than a defect: **door 6 has
two entrances**, `POST /api/bus/publish` (`daemon.js:5221`) and the bus WebSocket message handler
(`websocket.js:621`). Both funnel through `busAutoRoute`, so both are audited and the count is
unaffected — but a reader checking coverage would have to find that for themselves.

Downstream of the doors, checked and confirmed *not* to be entrances:

- `writeDataToSession` (`daemon.js:2241`) is the single PTY write primitive. Its four callers are
  `executeBootstrapInject` (`:1573`, `:1578`), `deliverInjectionToSession` (`:2853`, `:2875`,
  `:2881`) and the mailbox `DeliveryEngine.deliverFn` (`:5557`).
- The mailbox's only `enqueue` is `daemon.js:2830`, inside `deliverInjectionToSession`. The
  CHANGELOG's claim that the mailbox is transport and not an entrance **holds**. Residual worth one
  line somewhere: `FileMailbox` is file-backed under `HOME`, so a same-uid process that writes a
  mailbox file injects with no audit line — the uid boundary `BOUNDARY.md:183-189` already names,
  not a new door.
- The bootstrap/modal-park queue's only enqueue sites are `daemon.js:2718`, `:2741` (inside
  `deliverInjectionToSession`) and `:3974` (inside `POST /:id/submit`) — downstream of doors 1/2/3/6
  and 7.
- `cli.js:1982/2051/2243/2246/2356` and `interactive-terminal.js:66` are bridge-side writes
  downstream of `{type:'inject'}` frames the daemon sends.
- `submitViaOsascript` — unreachable, see F5.

Also verified against source: `source: "mailbox"` is produced by no `auditAppend` call site, so its
removal from the schema is correct; the audit `kind` values written by all seven sites are within
the documented `inject|multicast|broadcast|reply` set.

### The orchestrator's own commit `9003c01` — verified, correct

Routes are `app.post('/api/sessions/multicast/inject')` (`daemon.js:3669`) and
`app.post('/api/sessions/broadcast/inject')` (`:3745`). The only callers in the repo are
`cli.js:3252` and `cli.js:3306`, both using the `/inject` suffix. No file anywhere names the
un-suffixed form. Your correction is right.

---

## Q3 — Do the three branches compose?

They merged with zero conflicts and they compose correctly in `daemon.js` — bA's hunks (auth
short-circuit, observation emitter, ledger abort, DELETE teardown, bus audit) and bB's hunks (the
surface-GC block) do not touch the same regions or the same state. I looked specifically for the
"two individually-correct changes, jointly wrong" shape and found one, in the documentation rather
than in `daemon.js`:

### F3 — six supersession markers point at a CHANGELOG heading that bB abolished and bB's new test forbids.

At the base commit, `CHANGELOG.md:5` was `## Unreleased`.

- **bC** (`fb45d27`, `5231337`) added the supersession markers whose entire purpose is to stop a
  reader re-implementing the removed `TASK_COMPLETE` contract. Each one ends with a pointer:
  `` `CHANGELOG.md` → *Unreleased* → "BREAKING: telepty no longer asserts task completion (#60 Stage A)" ``.
  Correct against the tree bC was written on.
- **bB** (`8e59c28`, "0.8.0 must say 0.8.0") renamed that heading to `## 0.8.0 — unreleased` **and**
  added `test/release-version-invariant-844.test.js`, whose third test makes a `## Unreleased`
  heading permanently illegal: *"a version number in package.json is a claim to BE that release, so
  the notes for it must be filed under `## <version>`, not under a placeholder heading that can
  never disagree with anything."*

Different files, so nothing conflicted. Result: six pointers into the release documentation now name
a section heading that does not exist and that a test guarantees can never come back.

**Failure scenario:** a reader follows `specs/enforce-report-spec.md:11` — added in this release
precisely so they would not re-implement the deleted contract — opens `CHANGELOG.md`, searches for a
section called "Unreleased", and finds none. The one cross-reference whose job is to prevent the
re-implementation is the one that does not resolve.

Sites (all six are `→ *Unreleased* →` in added lines):

- `specs/enforce-report-spec.md:11`
- `specs/codex-inject-spec.md:9`
- `scratchpad/README.md:22`
- `docs/adr/2026-06-07-submit-via-pty-context-layer.md:8`
- `docs/specs/2026-05-12-status-detection-fix.md:10`
- `docs/superpowers/specs/2026-06-07-submit-via-pty-context-layer.md:10`

(`docs/reports/2026-07-26-757-kickstart-orphan-fix.md:51` also says `## Unreleased` — leave it, it is
a dated record of what a past change did and is accurate as history.)

**Cut:** s/`*Unreleased*`/`0.8.0`/ in those six lines. One `sed`, and it should be done before the
tag, because the markers are the deliverable of bC.

### F4 — a fourth tracked place still says `0.7.1`, and the new invariant enumerates three.

`README.md:441`:

```
| **telepty** | `@dmsdc-ai/aigentry-telepty` | 0.7.1 | Cross-terminal / cross-machine prompt transport (PTY daemon) | Shipping |
```

That row is generated. `scripts/gen-readme.mjs:26-30` applies a **self-override**: the repo's own
row always uses the local `package.json` version, *"so a repo never displays a stale version of
itself"*. So the intended rendering at this commit is `0.8.0`; it says `0.7.1` because
`gen-readme.mjs` has not been re-run since the bump.

`CHANGELOG.md:352-356` states what the new invariant measures — "those **three** manifest fields
agree with each other" — and then states what it does not measure: "whether the version is free on
npm, whether a git tag exists, and whether the prose under the heading describes the code". The
fourth tracked version claim is in neither list, and `test/release-version-invariant-844.test.js`
reads only `package.json` and `package-lock.json`. Verified: the suite is green with `README.md`
saying `0.7.1`.

**Failure scenario:** `git checkout integ/trial-0.8.0` at `9003c01`, open `README.md` (or view the
repo on GitHub at the release tag): the ecosystem table states telepty `0.7.1` for a tree whose
`package.json` says `0.8.0`. Bounded, because `prepublishOnly` regenerates the README into the npm
tarball and `.github/workflows/readme-regen.yml` fixes `main` after the GitHub Release is published
— so the *published* artifact is right and the *tagged repo* is wrong.

**Cut:** run `node scripts/gen-readme.mjs` and commit before tagging; add `README.md`'s own row to
`test/release-version-invariant-844.test.js` (it is a one-line regex against a generated file), or
name it in the "does not measure" list.

### F7 — `test:watch` was not updated with the nine files added to `test` and `test:ci`.

`package.json`: bB extended `test` and `test:ci` with `release-version-invariant-844`,
`target-token-refusal-844`, `refused-claim-not-a-teardown-844`, `refusal-classification-844`,
`positive-evidence-844`, `daemon-restart-title-44`, `lifecycle-surface-acceptance`,
`mailbox-bridge-flush-dedup-720`, `superseded-spec-markers-846`. `test:watch` is byte-identical to
its pre-release value. A developer working in watch mode gets a green that omits every guard this
release added. The repo's own precedent is to update all three lists (`CHANGELOG.md:818-819`).
Trivial cut; it is a fourth hand-maintained list and it has already drifted once.

---

## What I attacked and what held

- **The door table.** Re-counted from source rather than from the previous count. 6 recorded, 4
  unrecorded in 3 groups. **Correct.**
- **`session_process_exited` now requires `exit_observed_at`.** I looked for a producer of
  `trigger: 'process_exit'` that does not supply the field, which would silently demote a real
  observed exit to `unmapped_transition_cause`. There is exactly one producer — `markDead`
  (`session-state.js:296`), called only from the PTY `onExit` at `daemon.js:3262` — and it supplies
  it. **Held.**
- **`surface_orphaned`'s `ownerSocketOpen: true` / `reclaimed: false`.** These are constants: the
  block is entered only under `isOpenWebSocket(session.ownerWs)` and `'signal'` requires
  `ownerConnected: true`. That is the "field that can only ever hold one value" shape — but
  `CHANGELOG.md:321-322` names both literals explicitly as what the event carries, so the invariant
  is documented rather than disguised as a measurement. **Held.**
- **`decideSurfaceGcAction`'s `'reclaim'` return.** Dead at the only call site (`ownerConnected` is
  hard-coded `true`), and `src/lifecycle.js:257` says so in as many words. **Held.** One residual
  worth a line: `daemon.js:5744-5780` no longer has a `'reclaim'` branch, so a future caller passing
  `ownerConnected: false` gets silence rather than a reclaim.
- **`loadTeleptyConfig({ paths: [] })`** on the #843 C recovery path. `src/config-file.js:68-77`:
  `[]` is truthy, the loop does not run, `normalizeConfig({idle_ttl_default:'off'}, null)` is
  returned. The stderr message ("idle_ttl_default falls back to `off`") is accurate. **Held.**
- **`telepty daemon stop` after bB gated the state-file pid behind `pidMatchesTeleptyCmdline`.** This
  looked like a real regression, because `stopDaemon` force-disables the process-scan source
  (`daemon-control.js:446`), so the change could have left it with zero sources. Tested against a
  throwaway daemon: `pidMatchesTeleptyCmdline(pid) = true`, `stopDaemon → stopped: [{pid, source:
  'state-file'}]`. It works because `daemon.js:469` sets `process.title = 'telepty-daemon'`, which
  is what `ps -axo command=` returns on POSIX (confirmed against live processes on this host).
  **Held.** Undocumented residual, not a blocker: under `stopDaemon` both surviving sources now
  depend on the same `isLikelyTeleptyDaemon` match over the same process listing, so if that listing
  is unavailable or the daemon's command line does not match (a win32 dev checkout, where
  `process.title` does not change `Win32_Process.CommandLine` and the path lacks
  `aigentry-telepty`), `stopDaemon` returns `{stopped: [], failed: []}` and says nothing.
  `restartDaemonGraceful` still catches that case via its port-owner re-probe.
- **`resolveTargetToken`'s refusal** (`cli.js:226-241`). Covers all four loopback literals; Node's
  WHATWG `URL.hostname` returns `[::1]` bracketed, which `isLocalHostname` matches. The false
  positive on addressing your own daemon by tailnet IP is documented at `CHANGELOG.md:141-146`.
  **Held.** One behavioural note: `fetchWithAuth` can now throw **synchronously** where it
  previously always returned a promise. Every call site in `cli.js` is `await` inside `try`, so this
  is inert today — but `cli.js:2388` is `fetchWithAuth(deleteUrl).catch(() => {})`, a shape that a
  sync throw would walk straight past. It is safe only because that URL is always `DAEMON_URL`.
- **The resize argument.** I did not want to take this on the strength of a well-written comment, so
  I traced it: `viewerResizeDeliverer` sends `{type:'resize'}` to the owner bridge, and the bridge's
  handler is `cli.js:2259-2260` — `child.resize(msg.cols, msg.rows)`, nothing else. No bytes.
  **Held**, measured rather than accepted.

---

## Q4 — Ship or not

**SHIP-WITH-CUTS.**

Ship-blocking before the tag (cheap, all mechanical):

1. **F3** — s/`*Unreleased*`/`0.8.0`/ in the six supersession markers. These are bC's whole
   deliverable and they currently point at nothing.
2. **F4** — `node scripts/gen-readme.mjs`, commit. `README.md:441` says 0.7.1.
3. **F5** — drop the `osascript_cmd_enter` clause from `BOUNDARY.md:232-233` and
   `CHANGELOG.md:217-218`, or say the branch is dead.

Should land in 0.8.0, small:

4. **F1** — this is the one I would most want fixed in the release rather than after it, because it
   is a false *positive* in a capability block whose entire job is to say what was not measured, and
   it fires on every aterm session and in every pre-claim window. The narrow fix is a separate
   proved-at field.
5. **F2** — call `abortTrackedInjection` from the three terminal queue paths; name the
   accepted-and-parked state in `BOUNDARY.md`'s `delivery_result` bullet.

Nice to have: **F6** (cite `EVIDENCE-801.md` or drop the "Every"), **F7** (`test:watch`).

Nothing here is a security regression, nothing undoes a fix from r1/r2, and the door table — the
thing that has been wrong twice — is right this time. The release does what it says: I could not
find a path in it that produces a terminal task outcome.

---

## On my own position

I am Claude. The two prior reviews were Claude, the fixes were written by Claude workers, and the
cross-family gate you wanted (codex `gpt-5.6-sol`) did not spawn. **This review does not cover the
failure mode a different model family guards against — what a set of models sharing priors would
agree to miss.** Read the clean parts above as "nothing found by a reviewer with the same priors as
the authors", not as "nothing there".

You asked me to name where I noticed myself agreeing with the release's framing rather than testing
it. Three places, most valuable first:

1. **I nearly talked myself out of F1 using the release's own vocabulary.** My first read was:
   `session_authentication` sits next to `session_epoch`, the two use the *identical* predicate, the
   reason string is literally `no_815_epoch_fact` — so "observed" just means "an epoch fact exists",
   and the change is self-consistent. That reading is available, it is internally coherent, and it
   is how the fix's author got here. What breaks it is not a better reading of the docs but going to
   look at the three writers of `sessionEpoch` — at which point the comment's own word, *PROVED*,
   turns out to be true of one of them. **The framing was the thing that almost hid the defect, and
   the framing is written by the same priors that would review it.** If there is one place in this
   release where a different family would be worth more than I am, it is here.
2. **The `resize` argument.** I accepted it on the quality of the prose before I checked it, and
   noticed I had done that. I then traced it to `cli.js:2260` and it held — but the order matters:
   I agreed first and measured second, and I only measured because you told me to look for exactly
   this.
3. **"The mailbox is not an entrance — its ONE `enqueue` call site."** I read that and believed it,
   which is the same single-count move that produced "both write paths". I re-grepped: it is true
   (`daemon.js:2830`, plus a *separate* bridge-side `bridgeMailbox.enqueue` at `cli.js:1974` that is
   not this mailbox). But the sentence invites belief in a way an enumeration would not, and the
   release's own standing rule would have it name what it excluded.
