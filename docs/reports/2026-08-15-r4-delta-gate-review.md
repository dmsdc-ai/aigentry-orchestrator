# r4 — delta gate on telepty 0.8.0 (`integ/trial-0.8.0`, `git diff 9003c01..78beda6`)

Reviewer: architect, session `r4c-delta-gate`. READ-ONLY: no edits, no git writes, no daemon
control in `~/.aigentry/worktrees/mergetest`. Every repro below ran in-process or against a
throwaway daemon (`PORT=0`, temp `HOME` via `test-support/setup-env.js`). Working tree left clean
(`git status --porcelain` → only untracked `node_modules`, pre-existing).

**Verdict: SHIP-WITH-CUTS.** Five findings, four of them one-line documentation cuts, one of them a
reproduced record-vs-doc contradiction. Nothing here is a security regression and nothing undoes an
r1/r2/r3 fix. Four things I attacked held, including the two the fix's own comments claim hardest.

---

## Suite, run here

`npm test`, flagless, 3 consecutive runs: **1103 tests / 1102 pass / 0 fail / 1 skip, exit 0** on
every one. Counts identical across all three (`# tests 1103` × 3).

---

## Q1 — Does anything in this diff claim more than it measured?

Yes, in one record/doc pair (R1) and two prose enumerations (R3, R4). The new *vocabulary* itself —
`observed`, `queued`, `sessionEpochProved` — holds on every path I could reach.

### R1 — `BOUNDARY.md:292-297` says the observation ledger answers whether parked bytes were written. It answers only the failures. REPRODUCED.

> "On the single-target `POST /api/sessions/:id/inject` … `beginTrackedInjection` opens a record …
> and **the park and its outcome land there**: `inject_parked` when it parks, then
> `inject_delivery_refused` or `inject_delivery_dropped` if the queue never delivers it. So for that
> door, **whether the bytes were ever written is answered by the observation ledger** rather than
> here."

Three terminal paths now abort the record (`daemon.js:1978`, `:2089`, `:2789` — I re-enumerated the
queue's removal sites and there are exactly three: `daemon.js:1962` shift, `:2065` splice, `:2772`
splice, so that half is complete). The **fourth outcome — the drain succeeding — appends nothing.**
`executeBootstrapInject`'s success path (`daemon.js:1694-1697`) sets `lastActivityAt` and returns;
`drainBootstrapQueue` only calls `abortTrackedInjection` on `!result.success`.

**Failure scenario** (run in-process against the real module, output verbatim). Bootstrap-gated
`claude` session, tracked inject parks, bridge comes up, queue drains **successfully**:

```
delivery: {"success":true,"strategy":"bootstrap_queue","queued":true}
deliveryAuditResult -> queued
bytes on surface after park : 0
bytes on surface after drain: 1 ["[200~REPORT: a task[201~"]
--- LEDGER after a SUCCESSFUL delivery ---
tracking_state    : tracked
last_observation  : {"kind":"inject_parked","trigger":"bootstrap_queue",
                     "reason":"bootstrap_not_ready","bytes_written":0,"seq":2}
observations      : [tracking_started/inject_accepted, inject_parked/bytes_written:0]
```

The bytes are on the surface and the ledger's last word is `inject_parked, bytes_written: 0` —
**byte-identical to a dispatch still sitting in the queue.** The downstream consequence is concrete:
`bin/dispatch-tracker.sh:527-537` reads `observation.kind` and writes it verbatim into the registry
(`registry observe --kind "$kind"`), level-triggered, so the orchestrator's record for a *delivered*
dispatch carries `inject_parked` indefinitely.

This is the release's own defect class one layer out, and the fix's author saw exactly half of it —
`parkTrackedInjection`'s comment (`daemon.js:756-757`) says *"`tracking_state` stays `tracked` — a
park is not terminal, and claiming it were would be the same defect pointed the other way."* It is
the same defect pointed the other way that landed: the doc claims a measurement (bytes written?)
that the ledger never takes on the success path. Before #860 the ledger said `inject_accepted`,
which was silent about the park; now it says `inject_parked / 0 bytes`, which is *actively wrong*
after the drain, and BOUNDARY.md points the reader at it as the authority.

**Cut (choose one):**
- doc-only, one sentence: say the ledger records the park and its **failure** outcomes, and that a
  successful drain appends nothing — the park line is not superseded; or
- code, ~3 lines: append an `inject_delivered` observation with the measured `bytes_written` in
  `drainBootstrapQueue`'s success arm. `executeBootstrapInject` already computes the byte count for
  the CR-failure case (`daemon.js:1691`), so the measurement exists.

The doc cut is the ship-blocking half. The code half is 0.9.0-able, but note that until it lands
"was this dispatch delivered?" has **no** affirmative answer anywhere for a parked inject: the audit
log's last word is `queued` and the ledger's is `inject_parked`.

### R3 — `BOUNDARY.md:282-283` enumerates the doors that write `blocked:<reason>` and omits the `bus` door. MEASURED.

> "`blocked:<reason>`, written when the #533 peer-lane guard refused the payload before any write
> (`inject`, `multicast`, `broadcast`, `ws-viewer`)"

Five call sites write it, not four:

| site | door / `source` |
|---|---|
| `daemon.js:4628` | `inject` |
| `daemon.js:3809` (`rejectPeerLaneFanout`) | `multicast` / `broadcast` |
| `daemon.js:4883` | `ws-viewer` |
| **`daemon.js:5319`** (`auditBusWrite`, `source: 'bus'`) | **`bus`** |

The repo's own suite asserts the omitted one: `test/ws-viewer-inject-audit-826.test.js:334`
(*"#843: the BUS door cannot launder a #533 block"*) → `:358` asserts
`lines[0].delivery_result` matches `/^blocked:/`. Green on every run above.

**Failure scenario:** an operator auditing a bus-routed peer-lane block reads BOUNDARY.md's door
list, sees `bus` absent from it, and concludes the bus door does not record blocks — the exact
inference the #826 work exists to make impossible. Note the sibling clause in the *same sentence*
gets its count right (`queued` … "the same four doors as `success`"), so this is a hand list written
beside a correct one, which is the mechanism the CHANGELOG bullet at `:404` names.

**Cut:** add `bus` to the parenthetical. One word.

### R4 — `CHANGELOG.md:401` — "All three lists are back in agreement." They are not. MEASURED.

```
test: 109 files | test:watch: 109 | test:ci: 108
in test not in test:ci -> [ 'test/bridge-preconnect-output-768.test.js' ]
```

The behaviour is defensible — `test:ci:pty` runs that file as a separate job — but the sentence is a
bare coverage claim, unenumerated, in the bullet whose own thesis is *"an enumeration written by
hand, read as coverage, and compared against nothing"*. It was already false at `9003c01` (base:
test 105 / watch 86 / ci 104), so this is not newly broken; it is newly **asserted**.

The neighbouring number in the same bullet I re-counted and it is **correct**: `test:watch` was
exactly **19** files behind `test` at the base commit (I diffed the two lists out of
`git show 9003c01:package.json` — the ten `-60` observation files plus the nine r3 named). That is
also a silent correction of r3, which said nine; fB measured rather than trusting the prior gate.

**Cut:** "…`test` and `test:watch` are back in agreement at 109 files; `test:ci` omits
`bridge-preconnect-output-768`, which runs in the separate `test:ci:pty` job." One clause.

### What the new vocabulary does require, checked writer by writer

- **`sessionEpochProved`** — one writer, `src/transport/websocket.js:319`, on the line after the
  epoch it belongs to and on **both** arms so an unproven claim clears a predecessor's proof. I
  grepped the whole tree: no other assignment exists, and `src/session-store/persistence.js:46-51`
  deliberately excludes it from the serialized set (asserted at
  `test/session-authentication-proof-860.test.js:113`). Value-comparison rather than a flag, so a
  future writer that moves `sessionEpoch` alone fails **closed**. This is the correct fix for r3's F1
  and it does not repeat the three-writers/one-comment shape. **Holds.**
- **`observed`** — `sessionAuthenticationCapability` (`daemon.js:611-617`) is the only producer of
  the non-frozen value. The other five `CAPABILITY_STAGE_A` sites (`daemon.js:886`, `:913`, `:3157`,
  `:4919`, `:4974`) are no-record paths or the record's own stored block; none can mint `observed`.
- **`queued`** — `deliveryAuditResult` (`daemon.js:789`) is keyed on strategy **and** flag, and is
  used on all four audited doors (`:3861`, `:3937`, `:4729`, `:5334`). The mailbox trap it names is
  real and it avoids it.

---

## Q2 — Do `fA` and `fB` compose?

Yes in code; the two failures are both in `fB`'s prose about `fA`'s code (R1, R3 above), which is
precisely the shape the dispatch predicted — *"`fB` applied wording `fA` proposed for a file `fA`
cannot see."* Every other cross-reference I checked resolves against the code that shipped:

- The `#865` `inject_written` residual (`BOUNDARY.md:284-295`, `CHANGELOG.md:228-238`) describes the
  shipped code exactly. Verified: the single-target emission's only early return is
  `!delivery.success` (`daemon.js:4686`) and its `extra` block (`:4733-4752`) carries **no**
  `delivered` field; the bus emission carries `delivered: wrote` (false for a park),
  `delivery_result: 'queued'`, and `code`/`error` null — because `delivered` (`:5333`) is still
  `delivery.success === true` for a park, so the null arms are taken. The doc's careful
  "states nothing false and nothing true" is accurate, not a hedge.
- `BUS_EVENT_SCHEMA.md:265-275` — `kind` is `inject|multicast|broadcast`, `reply` removed. Verified
  against all seven `auditAppend` call sites (`daemon.js:3805`, `:3889`, `:4623`, `:4692`, `:4722`,
  `:4873`, `:5300`): five write `kind: 'inject'`, two write `kind: source`. No site writes `reply`.
- `verified_sender_epoch` / `verified_sender_generation` are derived in
  `src/audit/inject-log.js:52-53`, as documented.
- The removed **Termination Signal Detection** section: those strings exist nowhere in the source
  any more. Correct removal, not a doc regression.
- r3's F4 is **fully** closed: `node scripts/gen-readme.mjs --check` → *"README.md up to date"*,
  exit 0, no write. The committed README is byte-identical to a fresh generation, and
  `test/release-version-invariant-844.test.js:70-90` now covers the ecosystem row.
- r3's F5 and F6 are closed as prose: `BOUNDARY.md:228-236` and `CHANGELOG.md:214-221` now name the
  `osascript_cmd_enter` branch as dead code with the reason (`getSubmitStrategy` is a constant
  function); `scratchpad/README.md:6-8, 21-25` replaces the bare "Every" with an
  "every … **except `EVIDENCE-801.md`**" plus a per-file justification. Both follow the standing rule.

### R2 — r3's F3 fix embeds the half of the CHANGELOG heading that the publish step rewrites. The pointer breaks *at the tag*.

r3 proposed `s/*Unreleased*/0.8.0/`. What shipped is `*0.8.0 — unreleased*`, in all six markers:

```
docs/adr/2026-06-07-submit-via-pty-context-layer.md:8
docs/specs/2026-05-12-status-detection-fix.md:10
docs/superpowers/specs/2026-06-07-submit-via-pty-context-layer.md:10
scratchpad/README.md:28
specs/codex-inject-spec.md:9
specs/enforce-report-spec.md:11
```

`CHANGELOG.md:5` is `## 0.8.0 — unreleased`. Every one of the twelve sections below it is
`## X.Y.Z — YYYY-MM-DD`, and `test/release-version-invariant-844.test.js:44-45` states the rule in
its own words: *"`## 0.8.0 — 2026-08-15` … Anything after the version is free text: **the date is
filled in at publish time**."* The invariant test matches on the version prefix only, so it stays
green either way, and `test/superseded-spec-markers-846.test.js` checks for a `SUPERSEDED|HISTORICAL`
marker in the first 25 lines — **nothing in the suite checks that the pointer resolves.**

**Failure scenario:** the release commit fills in the date, `CHANGELOG.md:5` becomes
`## 0.8.0 — 2026-08-15`, and a reader following `specs/enforce-report-spec.md:11` — the marker added
in this release precisely so they would not re-implement the deleted `TASK_COMPLETE` contract —
searches the CHANGELOG for a section called *0.8.0 — unreleased* and finds none. That is r3's F3
verbatim, re-created by F3's own fix, with the fuse set to the act of shipping.

**Cut:** `s/0\.8\.0 — unreleased/0.8.0/` in those six lines — the version is the stable half of the
heading and is what r3 asked for. One `sed`, before the tag.

---

## Q3 — Is the suite's own evidence now trustworthy?

**The truncation defect is real, and the fix removes it.** I did not take fB's numbers; I built the
same defect from scratch and A/B'd it. Twelve synthetic files, nine trivial tests each, half of them
carrying the retired hook `test.after(() => { setImmediate(() => process.exit(0)); })`:

```
HOOKED  (6 files × 9 = 54 expected):  52  53  54  54  51  47   # fail 0, exit 0 on every run
CLEAN   (6 files × 9 = 54 expected):  54  54  54  54  54  54
```

4 of 6 hooked runs under-reported, the worst by 13% (47/54), and **every one printed `fail 0` and
exited 0.** The clean set was exact 6/6. That is an independent reproduction of the mechanism, of the
silence, and of the fix. `fB`'s specific figures (83/400 → 0/784) I cannot confirm at that sample
size; my three full-suite runs are consistent with them (1103 on all three), and the mechanism is
proven, so I would quote "the defect was real and is closed" rather than the ratios.

**The lint's self-check can fail — for three of its four assertions.** I mutated
`test/no-force-exit-in-test-hooks-861.test.js` four ways in a temp copy and ran only its detector
test:

| mutation | self-check |
|---|---|
| break the `after`/`afterEach` hook regex | **FAIL** ✔ |
| break the `process.exit` body predicate | **FAIL** ✔ |
| disable comment stripping | **FAIL** ✔ |
| **disable string-literal stripping** (backtick + double-quote) | **PASS** ✘ |

### R5 — the string-literal fixture in the lint's self-check is vacuous.

`test/no-force-exit-in-test-hooks-861.test.js:82-84` asserts that a stub-CLI fixture written as a
string literal is not flagged. Its fixture is

```js
hooksReachingExit('const stub = "if (x) process.exit(0);";\nafter(() => server.close());')
```

— the `process.exit(0)` sits **before** the `after(`, so the paren-balanced hook body never contains
it, stripping or no stripping. Measured directly: with *all* stripping removed the fixture still
flags 0. And with string stripping disabled, the real-file scan (test 2, over all 109 tracked test
files) is **also** still green — so the whole string-handling half of `stripCommentsAndStrings` is
unexercised by the suite in both directions.

**Failure scenario:** someone simplifies `stripCommentsAndStrings` (it is order-sensitive and its
comment says so) and drops the string branch. The suite stays green. The next test file that writes
a stub CLI *inside* a teardown hook — `after(() => fs.writeFileSync(p, "process.exit(0)"))`, a shape
`test/cli.test.js` and `test/lifecycle-surface-acceptance.test.js` already use at module scope — is
then flagged as an offender and CI goes red for a legitimate fixture, with the lint's message
telling the author to go find a handle that does not exist.

**Cut (nice-to-have, not ship-blocking):** move the `process.exit` inside the hook in that one
fixture — `after(() => { const stub = "process.exit(0)"; server.close(); })` — so the assertion
exercises what it names. The lint is correct today; only its evidence is short.

Two other properties I checked and they hold: the lint's `\b(?:test\.)?(?:after|afterEach)\s*\(`
also catches the subtest form `t.after(`; and the four surviving `process.exit` hits in `test/`
(`test/cli.test.js:79`, `test/lifecycle-surface-acceptance.test.js:45/50/55`) are all inside template
literals that are written to disk and spawned as children — the case the lint names as legitimate.

---

## What I attacked and what held

- **`modalParkResponse` gets a different strategy than `deliveryAuditResult` keys on.** I filed this
  as a finding before checking it: a surface-modal park is not a bootstrap queue, and the predicate
  only matches `strategy === 'bootstrap_queue'`. `modalParkResponse` (`daemon.js:2868`) delegates to
  `bootstrapQueuedResponse` (`:1668`), which sets `strategy: 'bootstrap_queue'` for both. **Held.**
- **The mailbox path's `queued` is claimed to always be a write** (`daemon.js:786-788`,
  `BOUNDARY.md:289-290`). `await mailboxDelivery.tick()` is wrapped in a bare `try {} catch {}`
  (`daemon.js:2995-2997`) and its `deliverFn` (`:5737-5745`) can nack, so the route can return
  `{success: true, strategy: 'mailbox'}` having written nothing. I built the case: an `aterm` session
  registered with a UDS endpoint that does not exist, then injected. `getInjectFailure`
  (`daemon.js:2328`) catches it first:
  ```
  inject status: 503  body {"success":false}
  AUDIT delivery_result: failed:DISCONNECTED
  LEDGER tracking_state: aborted | inject_delivery_refused / DISCONNECTED / bytes_written: 0
  ```
  The health gate stands in front of the mailbox path, so the claim **holds** on the path I could
  reach. I did not find a live-owner arrangement in which `tick()` silently writes nothing, and I am
  reporting that as "not found", not as "cannot happen".
- **The three terminal queue paths are all of them.** Re-enumerated from the queue's *mutation* sites
  rather than from the fix's list: `daemon.js:1962` (shift/drain), `:2065` (splice/boot timeout),
  `:2772` (splice/modal TTL) are the only removals; `op.cancelled` (`:2159`) is set only by
  `waitForBootstrapSubmit` and so only ever on `submit` ops. **Held**, and the `continue` at `:1964`
  is therefore not a fourth silent drop.
- **`abortTrackedInjection` called with a submit op's absent `injectId`.** `flushModalParkQueue`
  calls it for **every** drained op including submits (`daemon.js:2788`). `getTrackedInjection(undefined)`
  misses, returns `'tracking_unavailable'`, no throw — and `test/queued-inject-not-success-860.test.js:218`
  covers the untracked case explicitly. **Held.**
- **`bytes_written` on the CR-failure arm.** `executeBootstrapInject` returns
  `Buffer.byteLength(body)` where `body` is the **bracketed-paste-wrapped** payload
  (`daemon.js:1687-1691`), and the test asserts against `Buffer.byteLength(session.written[0])`, the
  same wrapped bytes. Consistent. The `bytesWritten: null` on the throw path is the honest answer and
  `abortTrackedInjection`'s `=== undefined` check keeps `null` distinguishable from a measured zero.
  **Held**, and this is the sharpest thing in the diff.
- **README staleness recurring.** `gen-readme.mjs --check` exists and is wired into neither `npm test`
  nor CI; only the ecosystem row's version cell is guarded. Not a defect — naming the residual.

### Residuals worth one line each, not findings

- `daemon.js:5356` re-expresses `deliveryAuditResult`'s predicate inline, and its own comment admits
  it (*"deliberately the same expression"*). Two writers of one concept, nothing binding them —
  the shape r3's F1 was. `const parked = deliveryAuditResult(delivery) === 'queued'` costs nothing.
- `daemon.js:2941` labels a **surface-modal** park with `trigger: 'bootstrap_queue'`; the true cause
  survives only in `reason`. Defensible (one FIFO, as BOUNDARY says) but the trigger is the field a
  consumer groups by.
- `daemon.js:3858` / `:3936` push a parked fan-out target into `results.successful`. The audit line
  now says `queued`; the HTTP response still files it under `successful`, with `strategy:
  'bootstrap_queue'` as the only disclosure. Same "read the fields, not the name" caveat the #865
  residual documents for `inject_written`, one surface over, undocumented.

---

## Q4 — Ship or not

**SHIP-WITH-CUTS.**

Before the tag (all mechanical, ~5 lines total):

1. **R2** — `s/0.8.0 — unreleased/0.8.0/` in the six supersession markers. This one breaks *at* the
   act of shipping, not before it.
2. **R1 (doc half)** — `BOUNDARY.md:296-297` must not claim the ledger answers whether the bytes
   were written. It answers the failures only.
3. **R3** — add `bus` to `BOUNDARY.md:283`'s `blocked:<reason>` door list.
4. **R4** — `CHANGELOG.md:401`: name the one file `test:ci` omits instead of asserting agreement.

Should land in 0.8.0 or be named as deferred: **R1 (code half)** — an `inject_delivered` observation
on the drain success arm; without it no surface answers "did the parked bytes land?" in the
affirmative. Nice to have: **R5** — make the lint's string-literal fixture exercise what it names.

The diff does what it says otherwise. `fA`'s two fixes are the correct shape for r3's F1/F2 —
separate proved-field with value comparison, strategy-keyed audit word, `bytes_written` measured
rather than assumed on both arms — and `fB` closed a real green-over-unrun-tests defect that I
reproduced independently. The queue's terminal paths are enumerated completely. I found no path in
this diff that produces a terminal task outcome, and no security regression.

---

## On my own position

I am Claude, the same family as the two prior reviews and as both workers who wrote this diff.
**This review does not cover the failure mode a different model family guards against — what a set
of models sharing priors would agree to miss.** Rounds 2's cross-family gate found four blockers a
five-lens same-family sweep had missed; nothing equivalent has run on rounds 3 or 4. Read the clean
parts above as *"nothing found by a fourth reviewer with the same priors as the authors"* — the
release notes should say it that way and not as "four rounds of review".

Where I accepted a claim because it was well-argued rather than because I checked it:

1. **`CHANGELOG.md:401`, "All three lists are back in agreement."** I read straight past it. It sits
   inside a bullet that is *explicitly about hand-maintained lists drifting and being read as
   coverage*, next to a "19 files" figure that turned out to be exactly right — and the correctness
   of the neighbour is what bought the sentence its credibility with me. I only caught it because I
   decided to count the lists for an unrelated reason. **The sentence that announces the defect class
   was an instance of it, and the prose quality is what got it past a reviewer who had been told to
   look for exactly this.** If there is one place a different family would be worth more than I am,
   it is a claim like this one, argued well by a model that shares my priors about what a careful
   sentence looks like.
2. **"the mailbox path … has already written synchronously … and that one is a write."** I read it,
   found it obviously right, moved on — then came back, saw the swallowed `try {} catch {}` around
   `tick()`, and went to build the repro. It held, on the gate rather than on the reason given. The
   order matters: I believed it first and measured second, and the reason given in the comment is not
   the reason it is true.
3. **R1, which I nearly did not look for.** `fA`'s comment says a park is not terminal and that
   claiming it were would be "the same defect pointed the other way" — a sentence so exactly on the
   release's thesis that I read it as evidence the author had covered both directions. They had
   covered one. I only ran the success-path repro because the r3 report's own lesson was "go look at
   the writers", and the success arm is the one writer nobody wrote a test for.
