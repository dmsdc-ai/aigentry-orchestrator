# SPEC — #1136 workflow productionization: approval, notification, reap, ledger, release

**Status** design contract, **revision 3** — r2 answered "stop re-approving and re-reporting"; the user has since asked for a loop that *keeps granted work moving with no further message from them*. r2's §3/§4/§8 exclusions cannot satisfy that, so this revision overrides them (§0) and adds §12. **Source** `main` `a3c97c2` (2026-09-09), re-measured for this revision; worktree `docs/1136-autonomous-loop` `069f6b5`, whose `src/` and `bin/` are byte-identical to `a3c97c2` (`git diff --stat main -- src/ bin/` = empty). r2's tree was `5baeecf`; every line/count below was re-checked, not inherited. **r3.1** corrects six source-review findings against r3 `54ea30a`; the six policy directions and bounded defaults are unchanged. **Owner** architect; no file below is written. **Nothing here is implemented** — every "gate", "verb" and "check" below is specified text until P1–P11 land.

Findings addressed: F1 approval retention, F3 duplicate completion notice, F2+F5 reap order and assignment state, F6 ledger append. F4 (router ref header) is #1133's. r3 adds L1–L8 (§12).

## 0. What later revisions withdraw

| Withdrawn claim | Measured reason | Now |
|---|---|---|
| "ZERO shared files with #1133" | `src/dispatch/cli.ts:668-716` is a live queue writer; wiring the transaction path **needs that file**, which is #1133 F3's | §1, §10 |
| lock only in the new helper ⇒ "no lost updates" | atomic rename is not lost-update prevention; two unlocked read-modify-write writers exist today | §1 |
| reap gated on terminal `lifecycle.state` | **circular**: `src/cleanup/cli.ts:474` is itself the writer of `cleaned`, and no other value means success | §5 |
| track-matched inbox presence = retention | a track match is not identity, and a REPORT can end a phase that continues | §5 |
| `^phase:` regex and the `<track>/-` fallback | measured refs carry `\| task: #N \|` **inline** and **no `phase:` at all**; `<track>/-` conflates unrelated events | §4 |
| "one notice per completion event" | a HOLD and REPORT split across two polls give EVENT + AMENDED = two notices | §4 |
| append-only approvals that flip an old record's status | self-contradictory | §3 |
| `[K]` substring in note prose as the idempotence key | arbitrary prose can contain `[K]` | §6 |
| "`tests/packaging/*.sh` run only in `release.yml`" | **false** — `.github/workflows/ci.yml:80,83,85` runs T96, T97 and `smoke-init.sh` on every push/PR, both OS legs | §7 |
| r2: "`report-sweep` has no production caller" | **false** — `src/reconciler/cli.ts:1281-1287` runs it every tick and logs every line (re-measured at `a3c97c2`). The true, narrower claim is that no sweep result is **delivered into an orchestrator turn** | §2, §4 |
| r2 §3 "**not built:** a dispatch-side approval gate" | with the loop, dispatch is machine-initiated; an ungranted task must be refusable **at the actuation boundary**, which no reviewer is standing at | §12.3 |
| r2 §4 "turn delivery is #1128's and **explicitly out of scope**" + §8 "actuation is instruction-only" | with no delivered turn the chain stops after every review. An ingress exists in-tree and is already used by this same daemon: `src/reconciler/cli.ts:787` (`deliverSleepDigest`) injects into `ORCH_SID` with `--submit-force` each tick | §12.4 |
| r2 §1: the `dispatch-stamp` as the record that a dispatch happened | the stamp runs **after** the inject (`src/dispatch/cli.ts:1162`, after `inject()` at `:1126`) and is best-effort. Autonomous selection may never read an absent stamp as "not dispatched" | §12.2 |
| r2 §5 V2 hashes the **inbox copy of the report** | a report is untrusted evidence *about* an artifact; retention must name the artifact (repo/commit/path/digest), which a report's own bytes never establish | §12.5 |
| r2 §5 V3 orders on `ref_mtime_ms` | file mtime is not an ordering authority (copies, clock skew, re-emit). Assignment identity and content shas are | §12.5 |
| r2 §5 "a drain failure **warns and proceeds**" | acceptable for a human-paced turn, wrong for a loop: one task's failed reap must block **that task's successor**, never every task | §12.5 |
| **r3** "no registry record ⇒ not sent ⇒ re-dispatch": treated as proof no worker exists | **wrong, and the more dangerous half.** Measured order in `main()`: `taskGateCheck` `:1033` → `resolveRoute` `:1074` → `applyCliCap`+**`spawnWorkspace` `:1075`** → `waitForReady` `:1095` → `prepareEffectiveRef` `:1097` → `beginDelivery` `:1102` → `inject` `:1126`. The workspace is created **~4.5 min before** the first registry write (`REGISTER_TIMEOUT_MS_DEFAULT` 180 000 ms `:42` + codex ready 90 000 ms `:935`). Registry absence means *no recorded inject attempt* and nothing else | §12.2 |
| **r3** revoke "re-read at the actuation boundary" (singular) | there are **three** boundaries, minutes apart, and the entry gate at `:1033` fences none of the later ones. An admitted, handed-off effect cannot be cancelled | §12.2 |
| **r3** "resource-local blocking" written as **task-local** | two tasks can share one worktree, branch or terminal sid; blocking by task id alone both under- and over-blocks | §12.3 |
| r2 §6 `note_op_ids` as a bare **array** of ids | §6 also requires "same id, different payload ⇒ exit 6". A list of ids cannot compare payloads; the check was unimplementable as written | §6 |

## 1. Queue writers and the shared transaction path

**Every live writer of `state/task-queue.json`, measured:**

| # | Writer | Mechanism today | Locked? |
|---|---|---|---|
| W1 | `src/dispatch/cli.ts:668-716` `taskLedgerUpdate()` | read → mutate `status`/`updated_at` → **append to `note`** → same-dir temp + `fsync` + rename; `JSON.stringify(data,null,2)+"\n"` (indent 2 pinned by #1110) | **no** |
| W2 | `bin/tq-focus.sh:18-20` | `jq '.active_focus=$t' > $(mktemp)` then `mv` — **cross-filesystem `mv`, not an atomic same-dir rename** | **no** |
| W3 | the orchestrator LLM's own `apply_patch`/Edit | whole-file replace | **no** |
| W4 | `bin/init/cli.mjs:301-307` | creates the file on a fresh workspace only; preserves an existing one | n/a |

W1 and the proposed `note-append` write **the same field**. Locking only the new helper would leave exactly that race unfixed, so:

- **One transaction path.** `bin/tq-write.py` becomes the only process that opens the queue for write. W1 is **rewired** to call it as a subprocess (`tq-write.py dispatch-stamp --task … --sid … --ref … --track … --cli … --by … [--capped-cli …]`), emitting byte-identical stamp text and keeping today's semantics exactly: promote `pending|queued → delegated` only, never regress `in_progress`, and **best-effort — warn, never fail the dispatch** (the inject has already landed). `src/dispatch/cli.ts:257-269` already shells to `bin/dispatch-registry.py` (`DISPATCH_REGISTRY_PY`, `:34`), so this is the established idiom, not a new one.
- W2 is rewired to `tq-write.py focus <track>`, which also removes the cross-filesystem `mv`.
- **W3 cannot be locked.** Honest limit: the transaction path covers *program* writers. A hand edit that read the file before the lock-holder committed can still lose an update. The deliverable against W3 is that the orchestrator calls the helper instead — **instruction-only** (§8), and the reason C4 exists at all.
- Lock: `fcntl.flock` on `<resolved queue path>.lock`, created on demand 0600, blocking with a bounded wait; commit is same-dir temp + `fsync` + `os.replace`, copying `bin/dispatch-registry.py:168` (lock ctx) and `:255` (commit). **The lock is the new part; the rename was never the guarantee.**

**Ownership consequence:** `src/dispatch/cli.ts` **is** shared with #1133 F3. Integration P7 is **serialized after #1133 F3 lands**, is confined to the body of `taskLedgerUpdate()` plus one drain call, and is owned by one coder (§10). No parallel edit of that file is proposed.

## 2. Other measured contracts

| Fact | Where |
|---|---|
| queue is indent-2, non-ASCII unescaped, one trailing newline; `note` is one string joined by ` \| ` / ` \|\| ` | `state/task-queue.json`, and W1's own serializer |
| `RETIRED_LIFECYCLES = {cleaned, cutover_retired, delivery_failed, not_delivered, superseded}`, with the file's own comment: "**None of them says anything about the TASK**" | `bin/dispatch-registry.py:50-54` |
| lifecycle writers: registry `delivery_attempt_started` `:462`, `superseded` `:489`, `not_delivered` `:602`, `delivery_state_unknown` `:605`; tracker `re_dispatched`/`disconnected`/`stuck_error`/`stuck_welcome` `:549,773,809,817`; reconciler `:376,524`; hitl `:277`; **cleanup `cleaned` `:474`** | measured 2026-09-08 |
| 80/80 dispatch records carry `outcome.state="unknown"`, `outcome_protocol="unavailable"` (`stage_b_deferred_to_0.9.0`); records key on `assigned.sid` + `dispatch_id`, never a task id | `state/dispatch/active.json` |
| `report-sweep` **has a production caller**: `src/reconciler/cli.ts:1280-1288` (step 0b) runs it every tick and tees **every stdout+stderr line** to `state/dispatch/reconciler.log` via `log()` (`:311`); gated by `AIGENTRY_REPORT_SWEEP` (default on), skipped under `DRY_RUN`. The loop is the launchd agent `com.aigentry.reconciler` (`--loop`, `KeepAlive`), `RECONCILER_LOOP_INTERVAL` default **60 s** (`:1195`) | measured 2026-09-08 |
| measured ref heads: `REPORT: … \| task: #1136 \| …` (inline, no `# REPORT` heading); dispatch refs carry front-matter `task: 1136`; **no ref carries `phase:`** | `~/.telepty/shared`, 4 most recent |
| `bin/**` is enumerated file-by-file in `bin/init/manifest.mjs`; T96 assertion 4 requires that count to equal `git ls-files bin` | `tests/packaging/T96_ship_set_agreement.sh:81-85` |
| `README.md` is generated from `README.tmpl.md` + `ecosystem.json`; `gen-readme.mjs --check` exists and is wired to **no** test or CI job | `scripts/gen-readme.mjs`, `.github/workflows/readme-regen.yml` |

## 3. C1 — approval as an immutable event history

`approvals` is an **append-only event list**. No element is ever edited or removed; status is **derived**.

```json
{"ev":"grant","id":"ap1136-3f9c21a8","gen":4,"at":"2026-09-08T13:04:11Z","scope":"<one line>",
 "tasks":["1136"],"phases":["spec","code","test"],"repos":["aigentry"],
 "actions":["dispatch","commit"],"spec_rev":"r3","expires_at":"2026-09-16T00:00:00Z",
 "limits":{"attempts_per_phase":2,"dispatches":12},
 "supersedes":null,"provenance":{"source":"user","quote":"<verbatim>","ref":"<ref-id|transcript ts>"}}
{"ev":"revoke","id":"rv1136-0c41","gen":5,"at":"…","target":"ap1136-3f9c21a8","provenance":{…}}
```

**r3 hardening — prose scope is not an authorization contract.** A machine actuator needs fields it can compare, so `tasks`, `phases`, `repos`, `actions`, `spec_rev`, `expires_at` and `limits` are **required on `grant`** (missing any ⇒ exit 2, nothing written), and `scope` stays as the human-readable line beside them. `gen` is a per-task monotone counter over the whole event list — the **fence** §12.2 checks. Derivation adds three refusals, all evaluated at the actuation boundary and again nowhere else: `expires_at` in the past ⇒ not active; `spec_rev` unequal to the spec revision the intent was authored against ⇒ not active (a rewritten spec invalidates its own approval); a `limits` counter exhausted ⇒ not active. `release` is **not** an `action` value any grant may carry implicitly — it is named or it is absent. Unchanged from r2 and re-affirmed: legacy rows are *unrecorded*, `pending`/`delegated` is **not** a grant, and no prose path reaches approval — a REPORT's text, a dispatch ref's own instructions and the word "continue" authorize nothing.

- **Derivation** a `grant` is *active* unless a later event `revoke`s it or a later `grant` names it in `supersedes`. Nothing else. `tq-write.py approvals <task>` prints the derived view; the history is the record.
- **Independent scopes coexist.** `supersedes` is explicit and single-target: a new grant never implicitly displaces unrelated active scopes.
- `--scope`, `--phases` and `--quote` are required on `grant`; `--target` and `--quote` on `revoke`. Missing any ⇒ exit 2, nothing written. The helper never reads free text and infers a grant — there is no prose or keyword path to approval.
- **Legacy** rows carry no `approvals` key: *unrecorded*, which is neither granted nor denied. Every existing path behaves exactly as today; no status value changes meaning.
- **Specified in r3 (r2 deferred it); not implemented.** The gate is ~10 lines inside the existing `taskGateCheck()` (`src/dispatch/cli.ts:623-661`), which already resolves the task row and already has the reject path: one more case, exit **11** (#1133 holds **10**). It fires **only** when `--loop-claim <id>` is present, so every human-initiated dispatch behaves exactly as today and no existing caller changes (Rule 29). Serialized behind P7 (§10).

## 4. C2 — notification grouping, and exactly what it can guarantee

**Identity is emitted by the producer, never inferred by the consumer.** The template gains one machine-readable line inside the first 400 bytes of every HOLD and REPORT: `event: <task>/<phase>/<attempt>` (e.g. `event: 1136/spec-revision/1`). This is required because measured refs carry `task:` inline after a pipe and carry **no** `phase:` at all — the `7422cdb` `^phase:` rule matched nothing, and its `<track>/-` fallback would have merged a track's unrelated events.

- **No `event:` line ⇒ no grouping.** The ref is notified individually, exactly as today. Absence of identity never produces a guess; legacy and third-party refs are unaffected. Ambiguity fails toward *more* notices, never fewer.
- **Same poll**, N refs sharing an `event:` ⇒ **one** `EVENT <id> — REPORT <ref-a> + HOLD <ref-b>` line. That is the measured F3 pair, whose refs are 1–22 s apart.
- **Later poll**, a further ref on a known id ⇒ one `AMENDED <id> — <ref-id> (<kind>)` line. **The guarantee is "at most one line per (event, poll)", not "one line per event ever":** a sweep cannot retract a line it already printed, and suppressing the later one would discard evidence. A HOLD and REPORT straddling a tick therefore yield 2 lines, and that is correct behaviour, not a defect. Cadence makes this concrete rather than theoretical: the poll is ~60 s (§2) and the four measured F3 pairs are 1–22 s apart, so pairs usually fall inside one tick — but the contract is stated at the weaker guarantee, not at the common case.
- **Duplicate vs correction** is decided on the copied bytes, not on kind: same `event:` + identical body sha ⇒ `DUP` (a redelivery); same `event:` + different body ⇒ `AMENDED`. Neither ever suppresses a file — **every ref is still copied verbatim to the inbox unconditionally**, and re-emit-never-loss (report-sweep §3) is untouched.
- State: an `events` map in `state/dispatch/report-cursor.json` beside `seen`, pruned on the same overlap window. A cursor loss is a cold start: identities are re-learned and lines re-emit — never lose, may repeat.
- **Consumer, precisely.** The sweep's lines **do** reach a durable artifact: the reconciler runs it each tick and tees every line to `state/dispatch/reconciler.log` (§2). So grouping has a real, inspectable effect today. What is absent is a **delivered turn notification** — nothing injects a sweep result into the orchestrator's turn, which is why the log existed and the 09-08 refs still waited for a human. Those are two different claims and r2 made only the first: the *shape and durability* of the output. **r3 overrides the second half of this bullet** (§0): the user has since asked for the chain to keep moving, which is impossible without a delivered turn, so §12.4 adds one — reusing the inject this same tick already performs at `src/reconciler/cli.ts:787`, and adding no daemon. What stays #1128's is whether an inject *reliably* reaches a turn; §12.4 does not depend on that, because it measures progress by receipt rather than by delivery.

## 5. C3 — reap on a reviewed settlement, not an inferred one

The `7422cdb` predicate was circular: `src/cleanup/cli.ts:474` is itself what writes `cleaned`, and every other `RETIRED_LIFECYCLES` value is a failure or supersession — the registry's own comment says none of them says anything about the task. **No lifecycle value means "this worker finished."** Settlement is therefore an orchestrator decision that is **recorded, then verified**; cleanup actuates it and never infers it.

Sidecar, keyed by an id `active.json` already carries, so its schema stays frozen for #1133 F4 — this is the alternative that keeps identity safe without a schema bump: `state/dispatch/settlements/<dispatch_id>.json`

```json
{"dispatch_id":"2818c54c…","sid":"lp1136-architect","task":"1136","phase":"spec","attempt":1,
 "grant":{"id":"ap1136-3f9c21a8","gen":4},
 "artifact":{"repo":"aigentry","commit":"<40-hex>","path":"docs/specs/…md","sha256":"…"},
 "evidence":{"inbox":"state/dispatch/inbox/<file>.md","sha256":"…"},
 "decision":"accept|reject|revise","continuation":"none|next-phase",
 "reviewed_by":"orchestrator","reviewed_at":"…Z"}
```

**r3 correction — the artifact, not the report about it.** `artifact` is the durable work product: repo, **commit sha**, path and content digest, re-verified with `git cat-file`/`git rev-parse` at reap time. The report's inbox copy moves to `evidence` and is still hashed, because *that a report arrived saying this* is worth retaining — but it is untrusted text and it never establishes retention on its own. `decision` is the reviewer's persisted verdict; a settlement without one is malformed (exit 6). r2's `event:` id stays available for grouping (§4) and is no longer load-bearing for identity here.

`bin/session-cleanup.sh --reap-reviewed [--task <id>] [--keep <sid>]` re-verifies **immediately before any side effect**:

- **V1 identity** `dispatch_id` is still the sid's current non-superseded record and its `assigned.sid` equals `sid` — a reused sid or a re-dispatch invalidates the settlement instead of inheriting it. Track substrings are not identity and are not used.
- **V2 artifact, corrected in r3.1.** r3 rewrote the prose and left this predicate reading on the inbox copy. The predicate is now the **artifact**: `artifact.commit` resolves in `artifact.repo`, `artifact.path` at that commit digests to `artifact.sha256`, **and the commit is still reachable from a retained ref** (`git merge-base --is-ancestor <commit> <branch>`, or the branch/tag named in the settlement) — an unreferenced object is garbage, not preservation. The inbox copy is checked separately as `evidence.sha256` and is never a substitute. **Refusals, each named in the exit-6 reason:** artifact fields absent (`ARTIFACT_UNRECORDED`); commit or path missing (`ARTIFACT_MISSING`); digest mismatch (`ARTIFACT_STALE`); commit unreachable from any retained ref (`ARTIFACT_UNREFERENCED`); evidence file gone or re-hashed (`EVIDENCE_STALE`); `decision` absent (`UNREVIEWED`). A phase whose product is not a committed file (a review verdict, a measurement) records `artifact:{"kind":"none"}` and is settled on `decision` + `evidence` alone — **no phase is given a fabricated artifact path**.
- **V3 continuation exclusion, ordered by assignment not by clock (r3).** r2 compared `ref_mtime_ms`; mtime is a copy artifact, not an ordering authority. Instead: (a) the registry holds **no non-superseded record for this sid whose `dispatch_id` differs from the settled one** — a re-dispatch is a new assignment and voids the settlement; (b) `re_dispatch_count` is unchanged since review; (c) the sweep cursor's `seen` ledger holds **no inbox file for this `(task, phase)` whose sha is neither the settled `evidence.sha256` nor already-settled** — content-addressed, so an out-of-order or replayed ref is compared, not raced; (d) `continuation` is `"none"`. Ambiguous resolution counts as failure.
- **V4 protections, unchanged** protected `orchestrator` sid (`cli.ts:45`), self/ancestor SIGTERM refusal (`:344`), `--keep`, worker-session refusal (`:642`).
- **Fail closed:** missing, stale or ambiguous ⇒ **exit 6, no kill, reason named**. Silence would hide a rejected reviewed decision. A sid with **no** settlement file is simply not a candidate — exit 0, nothing done — so a drain pass stays safe to run unconditionally.
- **Partial cleanup and races:** the three removal steps are already idempotent; a re-run re-verifies from scratch, and a settlement consumed by a completed reap is stamped `consumed_at` under the same lock, so a second pass is a no-op rather than a second kill.
- The three existing callers (`src/cleanup-scheduler/cli.ts:89`, `src/reconciler/cli.ts:77`, `src/session/open-session/cli.ts:384`) pass a bare `<sid>` and are **untouched** (Rule 29).

**Settlement ≠ completion.** V1–V3 establish that this *assignment* ended and its evidence is retained. On a verified reap: `tq-write.py owner-remove <task> <sid>`; when `owners` empties and status is `delegated` ⇒ **`in_progress`**, **never `done`**. Rows with no recorded `owners` are left untouched with an `UNOWNED` line. `owners` are written by the same `dispatch-stamp` call as W1 (§1) — in the ledger, not in `active.json`. Historical `delegated` counts are snapshots, and an absent dispatch record (#20, #28) means the history is missing, **not** that the task was never dispatched.

**Ordering, and r3's narrowing of what a failure blocks.** Enforced: `--spawn-and-dispatch` drains verified settlements before it spawns and records `reap_before_spawn=ok|failed|none` in the existing no-task telemetry sink, so A3 is measurable. For a **human-initiated** dispatch a drain failure still warns and proceeds — the harm of a late reap is a routing demotion, not corruption, and refusing an operator's dispatch over it is disproportionate. For a **loop-initiated** dispatch it does not: a failed or absent reap for task X blocks **X's successor phase only** (`BLOCKED_LOCAL task=X reason=<V1|V2|V3>`), and every other eligible task keeps advancing. One stuck cleanup never stops the fleet, and no failure path anywhere signals the orchestrator's own sid or ancestry (V4, `src/cleanup/cli.ts:45,344`). Recording the settlement remains the orchestrator's reviewed act; §12.4 is how the loop asks for it and §12.6 is what happens when it never comes. This drain lives in `src/dispatch/cli.ts`, i.e. inside P7 (§1, §10).

## 6. C4 — `bin/tq-write.py`

Python 3 stdlib only (Art. 17; python3 is already a hard dep of `bin/`). Subcommands: `note-append` · `status` · `owner-add|owner-remove` · `grant|revoke|approvals` (§3) · `dispatch-stamp` (§1) · `focus`.

- **Operation identity is structured, not textual.** `--op-id <k>` is recorded on the row in `note_op_ids`, which r3 makes an **object** `{"<op-id>": {"payload":"<sha256 of the argv payload>","at":"…Z"}}` rather than r2's bare array. Idempotence is key membership; the recorded digest is what makes the next rule checkable at all. Note prose is never scanned, so a `[K]` occurring inside old text can never be mistaken for an executed append.
- **Same id, different payload ⇒ exit 6, nothing written.** Decided by comparing the incoming payload's sha256 against the stored one — **r2 specified this refusal while storing only ids, which cannot compare payloads; that was unimplementable as written** (§0). Same id + same digest ⇒ no-op, exit 0. A genuine second append needs its own id.
- **A no-op writes nothing at all** — the file is not reopened, re-serialised or re-timestamped, and exit is 0. Semantic preservation is asserted separately from byte-identical serialisation: `note-append` reads the prior note from disk and concatenates ` || <segment>`, so the caller's argv carries only the new segment and prior text is never re-emitted through model output.
- **Refusals** unknown task id ⇒ 3; malformed queue JSON ⇒ 4, no write; `status` without a matching `--if-current` ⇒ 5, no write.
- **Serialisation** `json.dump(indent=2, ensure_ascii=False)` + trailing `\n`, identical to W1's serializer. Pinned by a round-trip case run against a **copy** of the real queue in a temp dir — no test mutates the live file.
- **Ship set** adding this file **requires** its `bin/init/manifest.mjs` entry, or T96 assertion 4 fails and both `ci.yml` and `release.yml` go red. Non-optional.

## 7. C5 — npm, install and README truth

**CI correction (this spec's own earlier error).** `tests/packaging/T96`, `T97` and `smoke-init.sh` run in **`.github/workflows/ci.yml:80,83,85` on every push/PR (ubuntu + macos) and again in `release.yml`**. They are not part of the local default `npm test` (`tsc -p . && scripts/run-tests.mjs`, which collects `dist/tests/**/*.test.js`). The `7422cdb` claim "only `release.yml`" is withdrawn.

**Unverified here:** registry contents. This spec asserts nothing about what is published; the builder phase runs `npm view @dmsdc-ai/aigentry-orchestrator versions --json` and reports the measured answer.

Measured conflict: `README.tmpl.md:5,19` and `ecosystem.json` (`package:"aigentry-orchestrator"` — missing the `@dmsdc-ai/` scope — `version:"—"`, `published:false`) say unpublished, while `release.yml` publishes on a `v*` tag and `readme-regen.yml`'s own header states the package IS published.

- **N1** Edit `README.tmpl.md` + `ecosystem.json`. `README.md` is **regenerated** by `node scripts/gen-readme.mjs`, never hand-edited — and the regenerated `README.md` is a committed, **owned** change in the same PR (§10 P5), not a side effect left to the bot.
- **N2** Every install/upgrade/uninstall claim names the exact command and the test exercising it; an untested claim is deleted, not softened. `bin/init/cli.mjs` offers `init [--workspace|--yes|--dry-run|--force|--upgrade]` and `--version` — **no `uninstall` verb** — so no README may imply one.
- **N3** Added to `smoke-init.sh` (already hermetic: real tarball, throwaway npm prefix, throwaway `HOME`, so a repo-relative or author-home assumption fails there): (a) the installed CLI **executes real work**, not only `--version` — `init --dry-run` then a real `init` into the throwaway workspace, asserting the created tree and a shipped helper resolving from the installed location; (b) upgrade preservation — sentinel under `state/`, `init --upgrade`, sentinel intact (`cli.mjs:295-297` claims it; assert it); (c) uninstall preservation — `npm uninstall -g` leaves the workspace and `state/` intact.
- **N4** Wire `node scripts/gen-readme.mjs --check` into `ci.yml`'s test job (owner P5), so template/ecosystem drift fails a PR instead of being silently regenerated on main.
- **N5** Publication is the builder's, after tests, under the standing authorization — no repeat generic permission prompt and **no automated restart of the live orchestrator**. A missing credential is a factual HOLD naming the secret by name only; its value is never printed (`release.yml` tests emptiness only).

## 8. Enforceable vs instruction-only

A runtime cannot make an LLM emit a tool call, and this spec claims no such power.

| Enforceable — a tool refuses, or the data cannot express the bad state | Instruction-only — guidance, measured after the fact |
|---|---|
| one locked transaction path for every *program* queue writer (W1, W2, helper) | the orchestrator uses the helper instead of hand-editing the queue (W3) |
| `grant` requires scope+phases+quote; history immutable; status derived, never patched | act in the turn that received approval (A1/A2) |
| `--reap-reviewed` fails closed on missing/stale/ambiguous settlement; protections unchanged | recording a settlement is the orchestrator's reviewed judgement |
| reap never writes `done`; `owners`-empty reaches `in_progress` only | final phase sends one REPORT with `needs:` and an `event:` line |
| `--op-id` membership idempotence; same-id-different-payload refused; no-op writes nothing | — |
| sweep prints ≤1 line per (event, poll) and copies every ref regardless | — |
| **r3:** claim CAS + `attempt` fence — a stale owner's write is refused, two ticks never claim one task | **r3:** that the woken turn *reviews* rather than rubber-stamps |
| **r3:** grant fields (`tasks`/`phases`/`repos`/`actions`/`spec_rev`/`expires_at`/`limits`) compared at the actuation boundary; exit 11 refuses an ungranted loop dispatch | **r3:** that the orchestrator authors the next ref at all — the loop can only wake it finitely, then `PAUSED` |
| **r3:** progress = a committed **receipt**, never a submitted inject; no receipt ⇒ finite re-wake ⇒ `PAUSED` with one durable reason | **r3:** that a `telepty inject` reaches a turn (unprovable here; #1128's ground) |
| **r3.1:** spawn intent and inject intent are separate durable states; replay reconciles the worker against **session identity**, never against a registry absence | **r3.1:** cancelling an inject that already landed — after hand-off only the *next* phase is withheld |
| **r3:** a reap failure blocks that task's successor only; the orchestrator's sid and ancestry are never signalled | — |

## 9. Acceptance cases

Each reproduces the recorded case **before** the fix, from fixtures or a **copy** of the real queue. No live daemon, no live queue mutation, no live session.

| # | Case | Expected |
|---|---|---|
| K1 | W1's ledger write and `note-append` run **concurrently** on the same row; and on different rows | both segments present, both rows updated, no lost update, file parses |
| K2 | the `tq-focus` path write concurrent with `note-append` | both survive; no cross-filesystem `mv` remains |
| K3 | the four measured HOLD/REPORT pairs, all refs in **one** poll | 4 `EVENT` lines, 8 inbox files |
| K4 | the same pair split across **two** polls | `EVENT` then `AMENDED` — 2 lines, asserted as correct |
| K5 | identical body redelivered on a known event; different body on a known event | `DUP`; `AMENDED` — neither drops a file |
| K6 | ref with no `event:` line (every ref on disk today) | notified individually, never grouped, never merged with another track |
| K7 | cursor deleted, sweep re-run | cold start re-emits; no ref lost |
| K8 | settlement whose `dispatch_id` was superseded, or whose sid was reused | exit 6, no kill (V1) |
| K9 | settlement whose artifact sha no longer matches, or whose file is gone | exit 6, no kill (V2) |
| K10 | a newer ref for the sid arrives after review (next-phase HOLD); `continuation:"next-phase"` | exit 6, no kill (V3) |
| K11 | protected `orchestrator` sid; a sid in the cleanup's own ancestry; an unrelated live worker with no settlement | none selected, no SIGTERM (V4) |
| K12 | reap interrupted after the kill then re-run; and two reaps racing one settlement | idempotent; the second is a no-op, not a second kill |
| K13 | verified reap of the last owner of a `delegated` task; and of a row with no `owners` | `in_progress`, `done` never written; `UNOWNED`, status untouched |
| K14 | same `--op-id` twice; same id with a different payload; an `[K]`-looking string inside old prose | no-op exit 0 and **no write**; exit 6; not treated as executed |
| K15 | malformed queue JSON; unknown task id; stale `--if-current` | exit 4/3/5, file unchanged |
| K16 | load→dump a **copy** of the real queue with no edit | byte-identical (pins indent-2 / newline / non-ASCII) |
| K17 | `grant` without `--quote`; two independent grants; `grant --supersedes`; `revoke`; re-read in a fresh process | exit 2 nothing written; both active; only the named one displaced; derived status correct after reload |
| K18 | `gen-readme.mjs --check` against a tree whose `ecosystem.json` changed | non-zero |
| K19 | installed-from-tarball CLI runs `init --dry-run` and a real `init`; then `--upgrade`; then `npm uninstall -g` | workspace created from the installed location; `state/` sentinel intact after both |

**r3 loop cases.** All run against a **fake** queue, fake `TELEPTY_SHARED_DIR`, fake `DISPATCH_STATE_DIR`, a stub `TELEPTY` recording argv, and `RECONCILER_NOW` as the clock. Zero live queue, session, daemon or process side effects; the stub is the only thing any inject reaches.

| # | Case | Expected |
|---|---|---|
| K20 | **the fixture**: granted chain A→B→C plus ungranted D; run N ticks with the stub answering each wake with a receipt | B and C claim, dispatch and settle with **no user message**; artifacts and settlements retained; **D never selected** |
| K21 | the same chain with `AIGENTRY_LOOP=0`, and again with an open destructive HITL gate | nothing claimed, nothing dispatched, no inject; state byte-unchanged |
| K22 | duplicate REPORT ref for one phase, in one tick and across two ticks | one receipt, one phase advance; every ref still copied (§4) |
| K23 | a corrected report arriving after review; a next-phase HOLD after review | reap blocked (V3 c/d), successor claim refused, one alert |
| K24 | refs whose mtimes are out of order vs. their assignment order | ordering taken from assignment identity + sha, not mtime; no misattribution |
| K25 | two ticks racing one task; a lease expired and its old owner writing late | one claim wins; loser exits 6 with no dispatch; the stale write is fenced off by `attempt` |
| K26a | crash **after admission, before `spawnWorkspace`** (`:1075`); no telepty row, no launcher file | `spawn:"intended"` reconciles to *not spawned*; one worker after replay |
| K26b | crash **after `spawnWorkspace`, before `beginDelivery`** (`:1075`→`:1102`, the ~4.5 min window) — a live session and a launcher exist, the registry is empty | `spawn` reconciles to `observed` from the telepty row + `session_epoch`; the inject half re-runs with `--target <sid>`; **no second workspace is opened, and no test asserts "not spawned" from registry absence** |
| K26c | same as K26b but the sid was reused by an unrelated later session (different `startedAt`) | `session_epoch` mismatch ⇒ `spawn:"unknown"` ⇒ `PAUSED`, nothing respawned, nothing injected |
| K26d | claim older than the prune cutoff with its record gone | `HISTORY_UNAVAILABLE` ⇒ `PAUSED`; absence is never read as a negative |
| K27 | crash after `begin-delivery`, before and after the inject | `transport.result:"unknown"` ⇒ `DISPATCH_RETRY_HELD`, one `decision` gate, **no second spawn, no auto-retry** |
| K28 | wake inject exits 0 but no receipt before the deadline | finite re-wake with backoff, then `PAUSED` with one durable reason; no third prompt, no "continue" in any recorded argv |
| K29 | `TELEPTY` absent; and `ORCHESTRATOR_STALE` already latched | intent persisted, loop paused with that reason; **zero** restart/kill/bridge argv recorded |
| K30 | `revoke` (higher `gen`) arriving before each of B1/B2/B3 in turn; and grant expiry / `spec_rev` change mid-chain | refused at that boundary, claim released, nothing dispatched; one `decision` gate, **not** a per-phase question |
| K30b | `revoke` arriving **after** `inject`, and one arriving between B3 and `inject` | recorded, next phase not admitted, running worker reaped via §5; **no test asserts the handed-off effect was cancelled** |
| K30c | lease expired with `spawn:"intended"`; and expired with `spawn:"observed"` on a dead session | first is **not** stealable (reconcile first); second is reclaimed by a CAS that bumps `attempt`, and the old owner's late write then fails closed |
| K30d | delayed ready: `waitForReady` times out at `:1095` after a successful spawn | `spawn:"observed"`, `inject:"not_attempted"`, `PAUSED`; the session is left alone, not killed and not re-spawned |
| K31 | attempts-per-phase, dispatches-per-grant, per-tick and CLI caps each exhausted in turn | selection stops, the exhausted limit is named, no busy spin; **no test asserts a token or dollar figure** |
| K32 | every task ineligible (deps, leases, pause); and a dependency phase that fails | one line, no dispatch, no alert storm; the failed dependency's successor is blocked while unrelated tasks still advance |
| K33 | reap fails V1/V2/V3 for task X; task Y **shares X's worktree/branch/sid**; task Z is unrelated | Y is blocked by the **resource** key, Z dispatches in the same tick, no global stall; no protected-sid or ancestor signal (V4) |
| K33b | an `ack` receipt arrives for every wake and no `review` ever does | phase never advances, breaker trips, `PAUSED`; an ack alone is never counted as progress |
| K34 | artifact absent / commit missing / digest changed / **commit unreachable from any retained ref** / evidence re-hashed / `decision` absent | exit 6 with the matching named reason (`ARTIFACT_UNRECORDED\|MISSING\|STALE\|UNREFERENCED`, `EVIDENCE_STALE`, `UNREVIEWED`), no kill; and an `artifact:{"kind":"none"}` phase settles on decision + evidence |
| K35 | tick killed mid-cycle then restarted, at each of the six state transitions | recovery is idempotent; no duplicate spawn, no double receipt, no lost settlement |
| K36 | **installed E2E**: tarball CLI drives a finite fake chain under a throwaway `HOME`/prefix | helpers resolve from the install; queue + grants + claims survive `init --upgrade`; no repo- or author-HOME path in any resolved argv |

## 10. File split, ownership, dependency edges

| ID | Files | Change | Owner | Depends on |
|---|---|---|---|---|
| P1 | `bin/tq-write.py` **(new)** | §6 §3 §1 helper; **r3:** `claim`/`release`/`receipt`/`action-add` verbs, `attempt` fence, r3 grant fields, `note_op_ids` as a digest map; **r3.1:** §12.8 structs, `spawn`/`inject` split | coder-A | — |
| P11 | `bin/init/manifest.mjs` | ship-set entry for P1 — **r3.1:** a separate file and a separate owner, but it must ride in **P1's PR**, or T96 assertion 4 fails the moment the new `bin/` file lands | coder-F | P1 |
| P2 | `src/tracker/report-sweep.ts`, `src/tracker/usage.ts` | §4 `event:` parse, grouping, `events` in the cursor | coder-B | — |
| P3 | `src/cleanup/cli.ts`, `src/cleanup/usage.ts` | §5 `--reap-reviewed`, V1–V4, settlement sidecar | coder-C | P1 |
| P4 | `docs/templates/dispatch-ref-template.md`, `docs/templates/dispatch-ref-checklist.md` | §4 `event:` line + one-final-REPORT rule | coder-B | — |
| P5 | `README.tmpl.md`, `ecosystem.json`, **`README.md` (regenerated)**, `tests/packaging/smoke-init.sh`, `.github/workflows/ci.yml` | §7 N1–N4 | coder-D | — |
| P6 | `bin/tq-focus.sh`, `bin/tq-status.sh` | route W2 through P1; surface derived approvals | coder-A | P1 |
| P7 | `src/dispatch/cli.ts` | §1 `taskLedgerUpdate()` → `dispatch-stamp`; §5 settlement drain before spawn; **r3:** `--loop-claim <id>` + the exit-11 grant gate inside `taskGateCheck()` (`:623-661`) | coder-B | P1, **#1133 F3** |
| P9 | `src/reconciler/cli.ts`, `src/reconciler/usage.ts` | **r3:** step 0b3 — the loop tick (L1–L3, L7, the wake), between `:1287` and `:1290` | coder-E | P1, P3, P7 |
| P8 | new tests under `tests/dispatch/` + `tests/packaging/` | K1–K19 | tester | P1–P7 |
| P10 | more tests under `tests/dispatch/` + `tests/packaging/` | **r3:** K20–K36 | tester | P9 |

**Edges** `P1 → {P3, P6, P7, P11}`; `{P1…P7} → P8`; **r3:** `{P1, P3, P7} → P9 → P10`. **r3.1 — `#1133 F3 → P7` is a *serialization reservation*, not a content dependency.** P7 needs `src/dispatch/cli.ts` free of a concurrent editor; it needs nothing #1133 F3 produces. Which of the two goes first is the **orchestrator's reservation to make**, and if #1133 F3 is not ready, P7 may take the file first — the loop is not blocked on it. Recorded so the edge is not read as an inherent prerequisite. **Parallel-safe** P1 ∥ P2 ∥ P4 ∥ P5. P2, P3 and P7 are TypeScript: `tsc -p .` must run before any guard, and `npm test` refuses a stale `dist/` (`scripts/run-tests.mjs:37-47`). No file is edited by two owners, and no file is touched outside this table.

**Runner inclusion, verified.** `npm test` auto-collects `dist/tests/**/*.test.js` — a new `.test.ts` needs no registration. A new **shell** guard under `tests/dispatch/` is globbed by `T*.sh` but `tests/dispatch/run-all.sh:52` pins `EXPECTED_GUARDS=135`, which **must be bumped in the same commit**. `tests/packaging/*.sh` run in `ci.yml` and `release.yml`, not in local `npm test`. **Discovered id set:** re-measured at `a3c97c2` — `EXPECTED_GUARDS=135` (`tests/dispatch/run-all.sh:52`) and the highest existing guard is still `T150`, so `T151+` appears free — **reported as a discovery for the orchestrator to reserve; this session reserves nothing** (#1133 draws from the same range).

## 11. Rollout, rollback, unknowns

Stage 1 P1 (additive; nothing reads the new fields) → 2 P6 (writers converge on the transaction path) → 3 P2+P4 (notification) → 4 P3 (reaping) → 5 P7 **after #1133 F3** → 6 P5 (release truth) → 7 tests, build, pack and publication as **delegated phases after this spec is reviewed**. Each stage lands behind its K-cases and is independently revertable; P7 reverts to today's inline `taskLedgerUpdate()`. No migration: `approvals`, `owners`, `note_op_ids` and the settlements directory are absent until first written.

**Unknowns, to be measured by the implementer rather than assumed:** whether any non-orchestrator producer emits refs that would need an `event:` line; how the settlement sidecar interacts with registry `prune` (`bin/dispatch-registry.py:659`) once dispatch records age out; registry contents (§7). **Not claimed anywhere:** token or cost figures, idle-vs-busy ratios, LOC, timing targets, or any cap-demotion target — capacity limits remain legitimate and this spec changes no counting. **Future coders:** run `snyk_code_scan` (or `bin/snyk-scan.sh`) on changed first-party code, then fix and rescan before DONE; this doc-only phase is N/A. **Open for the orchestrator:** reserving the test-id block, and whether `owner-add` enters the dispatch routine at P1 or waits for P7.

**r3 loop rollout — three stages, no live activation in this phase.** `AIGENTRY_LOOP` defaults to **0**, so P9 lands inert and stage 1 is the merge itself. **Stage 1 observe-only:** the tick's existing `--dry-run` arm already suppresses every actuation; the loop step logs `WOULD-CLAIM` / `WOULD-DISPATCH` / `WOULD-WAKE` and writes nothing, so a day of `reconciler.log` shows what it *would* have done against real state before it does anything. **Stage 2 constrained canary:** `AIGENTRY_LOOP=1` plus `AIGENTRY_LOOP_TASKS=<one id>`, one dispatch per tick, one grant with a short `expires_at` — a single chain, opt-in, revocable by editing one env value. **Stage 3:** the approved scope, still per-grant. **Rollback** is `AIGENTRY_LOOP=0`: the queue, grants, claims, settlements and inbox are all durable and are read, never truncated, by the off path — and it stops *selection*, so a worker already dispatched keeps running and is reaped normally. Nothing kills a working session. An open destructive HITL gate pauses the loop with no new mechanism (§12.6). **r3 unknowns, for the implementer to measure rather than assume:** whether `telepty inject --submit-force` into `ORCH_SID` reliably yields a turn under load (the receipt design is what makes the answer non-blocking, but the rate should be recorded in stage 1); and how a paused claim interacts with registry `prune` once records age out.

## 12. L — the autonomous task loop (r3)

§1–§11 are r2's accepted text, amended in place and marked; this section is r3's addition, and §8–§11 carry `r3:` rows that point here.

**Where the chain stops today, measured, is two different things at one seam.** **S1 — no turn.** A worker's `telepty inject --ref` can be dropped when the orchestrator is busy (`src/tracker/report-sweep.ts:4-30`; the recorded case is a report written 22:07 and noticed 22:48). `report-sweep` recovers the *file* into `state/dispatch/inbox`; nothing recovers the *turn*. **S2 — turn without actuation.** When a turn does happen it ends in prose ("next is builder/tester") and nothing causes another; r2 §8 named this instruction-only and stopped there. Neither is a wording problem. Both are fixed by making a **daemon** the actor for every deterministic step and the LLM the actor for exactly one — reviewing a report and authoring the next ref.

### 12.1 The cycle, and which actor runs each step

| Step | Actor | Reuses (measured at `a3c97c2`) |
|---|---|---|
| **L1** select next eligible granted task | tick | task rows + `blocked_by`/`priority` (both already in the schema), §3 grant |
| **L2** claim: CAS + fence, **before any side effect** | tick → `tq-write.py claim` | §1 single transaction path (`fcntl.flock`, `bin/dispatch-registry.py:163-192`) |
| **L3** dispatch the authored ref | tick → `bin/dispatch.sh` | registry `begin-delivery` writes a durable record before the **inject** (`bin/dispatch-registry.py:457-497`; `:1102` then `:1126`) — but **after** `spawnWorkspace` `:1075`, which is why §12.2 records spawn and inject as two intents |
| **L4** report collection | tick → `report-sweep` | `src/reconciler/cli.ts:1281-1287`, already running every tick |
| **L5** **review the report; author the next ref** | **orchestrator LLM**, woken by L4 | §12.4 |
| **L6** persist decision, phase/task update, settlement | orchestrator → `tq-write.py` | §3, §5, §6 |
| **L7** verify artifacts, reap | tick → `session-cleanup.sh --reap-reviewed` | §5 V1–V4 |
| **L8** → L1 | | |

L5 is irreducible and deliberately kept: a report is untrusted evidence and the reviewer's decision must be persisted (§5). **The loop never manufactures it.** Everything else is deterministic, and none of it needs a person — which is exactly the delta the user asked for. The loop is one new step in an existing tick (`step 0b3`, between the sweep at `:1287` and the comms auditor at `:1290`), not a new daemon, service or queue.

### 12.2 Two intents (spawn, inject), serialized admission, fencing, and replay

r2 treated the ledger `dispatch-stamp` as the dispatch record; it is written at `src/dispatch/cli.ts:1162`, **after** `inject()` at `:1126`, and is best-effort, so an absent stamp proves nothing. **r3.1 corrects the larger error**: r3 then treated *registry* absence as proof that nothing happened. The measured order (`main()`, `a3c97c2`) is `taskGateCheck` `:1033` → `resolveRoute` `:1074` → `applyCliCap` + **`spawnWorkspace` `:1075`** → `waitForReady` `:1095` → `prepareEffectiveRef` `:1097` → `beginDelivery` `:1102` → `inject` `:1126`. `spawnWorkspace` runs `bin/open-session.sh` — a real terminal session, a real CLI process — and `beginDelivery` is the **first** registry write, up to ~4.5 min later (`REGISTER_TIMEOUT_MS_DEFAULT` 180 000 ms at `:42`, codex ready 90 000 ms at `:935`). So **a registry absence is evidence about the inject only; it is never an external negative about a worker.** Two intents, recorded separately:

```json
"claim": {"attempt": 3, "phase": "code", "sid": "lp1136-coder",
          "grant": {"id": "ap1136-3f9c21a8", "gen": 4}, "spec_rev": "r3.1",
          "resource": {"repo": "aigentry", "worktree": "…/worktrees/lp1136", "branch": "docs/1136-…"},
          "action_digest": "<sha256 of the frozen action struct>", "ref_sha256": "…",
          "spawn":  {"state": "intended|observed|unknown", "session_epoch": null, "at": "…Z"},
          "inject": {"state": "not_attempted|unknown|recorded", "dispatch_id": null, "at": "…Z"},
          "leased_at": "…Z", "lease_expires_at": "…Z"}
```

- **Admission is serialized, once.** One `tq-write.py claim --if-attempt <k>` under the §1 lock is the single admission point; it commits `attempt = k+1` and `spawn.state:"intended"` **before** `dispatch.sh` is spawned. Only the holder of the current `attempt` may write, so two ticks cannot both be admitted. Everything after admission is that attempt's, and `attempt` is carried on every later write (`release`, `receipt`, settlement, `dispatch-stamp`) and refused if the row has moved on.
- **Spawn outcome, measured not assumed.** After `dispatch.sh` returns, the loop records `spawn.state:"observed"` together with `session_epoch` — the `startedAt` of the sid's row in `telepty list`, bound into the registry's **existing, currently-always-null** `assigned.session_epoch` field (`bin/dispatch-registry.py:459,724`), so a later *reused* sid is a different session and not ours. If `dispatch.sh` died or the sid is absent from the listing, `spawn.state:"unknown"` is persisted and **nothing respawns**.
- **Replay, per state, with no negative inferred from an absence:** `spawn:"intended"` ⇒ a workspace may exist; reconcile against **session identity** (`telepty list` row for the sid, its `startedAt`, and the sid-keyed launcher `~/.aigentry/sessions/<sid>/guard/worker-launcher.sh` that `writeWorkerLauncher()` wrote before the spawn) — a matching live session becomes `observed`, its absence becomes `unknown`, never "not spawned". `spawn:"observed"` + `inject:"not_attempted"` (no registry record for `(sid, ref_hash)`) ⇒ the worker exists and was **not** told anything: re-run the inject half **against the existing session** (`--target <sid>`, not `--spawn-and-dispatch`), so no second worker is possible. `inject:"unknown"` ⇒ possibly delivered: the registry already refuses it with exit 7 `DISPATCH_RETRY_HELD`; one `hitl --kind decision` gate, never an auto-retry. Any `unknown` ⇒ `PAUSED` with the state named.
- **Pruned history is not a negative either.** `op_prune` (`bin/dispatch-registry.py:659-680`, default cutoff 86 400 s) removes only records already in `RETIRED_LIFECYCLES`, so it cannot touch a live `delivery_attempt_started` row inside a replay window — but the loop still treats a *missing* record as `HISTORY_UNAVAILABLE` when the claim is older than the cutoff, and pauses rather than concluding.
- **Three boundaries, and what revoke can and cannot do.** `taskGateCheck` at `:1033` runs before route, spawn and readiness, so an entry check fences none of them. Revoke/pause (`gen` greater than the claim's) is re-read at **B1** immediately before admission, **B2** immediately before `spawn`, and **B3** immediately before `beginDelivery` — the last point at which nothing has been handed off. Refusal at any of them releases the claim and dispatches nothing. **After `inject` there is no cancellation**: the bytes are in someone else's session, and this spec promises only that the *next* phase is not admitted and that the running worker is reaped through §5. A revoke arriving between B3 and `inject` is a race this design does not pretend to win; it is recorded, not claimed.
- **A lease is not stealable merely by expiring.** `expired` + `spawn:"intended"|"unknown"` ⇒ **not stealable** — take-over requires a reconciled spawn state first. Only `expired` + (`spawn:"observed"` with a dead/absent session, or `spawn` never intended) is reclaimable, by a CAS that bumps `attempt`, which is what makes the old owner's late write fail closed.
- **No exactly-once claim anywhere.** Delivery is at-least-once with durable dedup on `(sid, ref_hash)` — the registry's existing `dedup.key` — and every uncertainty resolves to a persisted state and a human decision, never to a retry.

### 12.3 Eligibility, deterministically

`eligible(T)` ⇔ an active grant covers `(T, phase, repo, action=dispatch)` and is unexpired, un-revoked and `spec_rev`-current (§3) **and** every `blocked_by` id is `done` **and** no live claim/lease **and** no unsettled predecessor phase for `T` **and** **no live claim holds a conflicting resource** **and** limits unexhausted (§12.6).

**Resource identity (r3.1) — blocking is resource-local, which is not task-local.** Two different tasks can own one worktree, branch or terminal sid, and r3 wrote "that task's successor" as if task id were the unit. The minimum key is the tuple the dispatch record already carries: `(repo, worktree, branch, sid)` — `cwd`/`worktree`/`branch`/`assigned.sid` all exist on the record today (`bin/dispatch-registry.py:457-497`). Claims conflict when any component matches a live claim's, and the same comparison is used at **selection**, at **reap** and when admitting a **next action**: X and Y sharing a worktree serialize; Z elsewhere advances in the same tick. A failed reap blocks the successors of everything holding its resource — not one task id, and not the fleet. Order: `priority` (P0<P1<P2), then `blocked_by` depth, then ascending task id — total and stable, no heuristic, no scoring. The user's sentence authorizes **building** this loop; it grants nothing to run. Every task the loop touches needs its own §3 grant, so an ungranted backlog item is not merely deprioritized — it is not selectable.

### 12.4 The wake: a real turn, and progress measured by receipt

The ingress is not new and is not a logfile: `src/reconciler/cli.ts:787` already injects into `ORCH_SID` with `telepty inject --submit-force --from <orch> <orch> <msg>` every tick when it has something to deliver (`deliverSleepDigest`), and `:660` does the same to a worker sid under a latch and an hourly cap (`RESUME_MAX_PER_HOUR`, default 3). The loop reuses that exact argv and that exact ledger shape.

- The wake is **level-triggered on state**, not edge-triggered on an inject — which is why it also covers **S1**: a REPORT whose inject was dropped is still an unreviewed inbox file, and the next tick wakes on the file.
- **A wake carries unreviewed evidence, never a settlement** (r3.1 — r3's sample said "settled" *before* review, which misstates the evidence it is handing over): `LOOP: task 1136 phase spec REPORTED, unreviewed (dispatch 2818c54c, evidence state/dispatch/inbox/<f>.md sha <…>, claimed artifact <commit>:<path> — unverified); grant ap1136-3f9c21a8 gen 4 covers phase code; review it, then tq-write.py receipt --task 1136 --attempt 4 --decision <accept|reject|revise> …. The loop dispatches what you author; do not dispatch by hand.` No "continue" is ever sent, and no wake repeats the previous one's text.
- **A submitted inject is not progress.** Progress is a **receipt**: a committed `tq-write.py receipt` carrying the wake's id and the current `attempt`, which is what moves the row. Delivery is unprovable from this side (that is #1128's ground), so the loop asserts nothing about it and reads only the receipt.
- **No receipt by the deadline** ⇒ finite re-wake (default 2, exponential backoff off the same hourly ledger) ⇒ then **`PAUSED`** on that task with one durable reason in the row and one `alerts.log` line. Not a third prompt, not a loop. Ingress unavailable (`telepty` absent, or `ORCHESTRATOR_STALE` already detected at `src/reconciler/cli.ts:1367-1382`) ⇒ the intent is persisted and the loop pauses with that reason. It never restarts, kills or re-bridges the orchestrator — `#606` keeps that user-only, and `src/reconciler/cli.ts` already declines it in the same situation.

### 12.5 What is preserved, and what a failure blocks

Artifact retention, settlement identity and reap ordering are §5 as amended by r3: the **artifact** (repo/commit/path/digest) is what is verified, the report is evidence beside it, ordering comes from assignment identity and content shas rather than mtime, and a reap failure blocks **that task's successor only**. The loop adds no cleanup path of its own; it calls `--reap-reviewed` and reads its exit code.

### 12.6 Limits — and one honestly unavailable

**Unavailable, stated rather than faked:** token and dollar accounting. Nothing in-tree meters either — `bin/model-router.mjs` selects a model, and #1084's cap (`src/dispatch/cli.ts:479-502`) counts **live sessions**, not usage. **This spec claims no cost or token cap** and no test may assert one. What is enforceable and used instead:

| Limit | Mechanism | Default |
|---|---|---|
| concurrent workers per CLI | `AIGENTRY_CLI_CAP_<CLI>` — existing, already applied on every fresh spawn | codex 2, claude 4 |
| dispatches per tick | new counter in the loop step | 1 |
| attempts per phase | grant `limits.attempts_per_phase`; exhausted ⇒ `PAUSED` | 2 |
| dispatches per grant | grant `limits.dispatches` | 12 |
| per-phase progress deadline | registry `expected_report_by` — **existing**, `dispatched_at + 30m` (`bin/dispatch-registry.py:470`), already polled by the tracker each tick | 30 min |
| no-progress breaker | N consecutive ticks holding a claim with no receipt and no report ⇒ `PAUSED`, reason recorded | 30 (≈30 min at the 60 s tick) |
| global stop | `AIGENTRY_LOOP=0`; and an open `--kind destructive` HITL gate already forces `DRY_RUN=1` for the whole tick (`src/reconciler/cli.ts:1225-1233`) | loop off by default |

Six knobs, five of them grant-scoped rather than global. The tick already runs every 60 s and does far more than this; the loop adds no polling of its own, so there is no busy spin to bound.

### 12.7 Human gates — and where they are *not*

Gates use the existing `bin/hitl.sh open --kind destructive|decision|info` (`src/hitl/cli.ts:334`), which the tick already reads. **Gate:** new architecture or business scope; destructive actions; grant expiry, revocation or `spec_rev` invalidation; a possibly-sent UNKNOWN; release with no standing `action:"release"`. **Do not gate:** each approved phase inside a live grant, an operational retry inside the limits, or a routine reap. The loop asks once per *scope*, not once per *phase* — asking every phase is the behaviour this task exists to remove.

### 12.8 `action`, `claim`, `receipt` — the structs P1 must not invent at coding time

**`action`** is what gets dispatched, authored by the orchestrator and **frozen at admission**; `action_digest` = sha256 over its canonical form (sorted keys, no whitespace), and any change to it or to the ref bytes is a **new action**, never an edit:

```json
{"task":"1136","phase":"code","repo":"aigentry","worktree":"…","branch":"…",
 "sid":"lp1136-coder","role":"coder","cli":null,"action":"dispatch",
 "ref_path":"…","ref_sha256":"…","authored_by":"orchestrator","authored_at":"…Z"}
```

The **first** action of a chain is authored by the orchestrator in the turn that requests the loop (`tq-write.py action-add`); every later one arrives on a `review` receipt. **The daemon authors none.** An action becomes *eligible* only when its predecessor phase is settled (§5), its grant covers `(task, phase, repo, action)` and its resource is free (§12.3).

**`receipt` has two kinds, and only one advances anything.**

| kind | required | effect | does **not** |
|---|---|---|---|
| `ack` | `--task --attempt --wake-id --op-id` | records that a turn consumed that wake; suppresses a duplicate wake for that `wake_id` | advance the phase, settle, clear the no-progress breaker, or count as review |
| `review` | `ack`'s fields + `--decision accept\|reject\|revise --evidence-sha256 …` + `--artifact repo:commit:path:sha256\|none` + optional `--next-action <file>` | persists the reviewer's decision, writes the settlement (§5), and admits `next_action` for later selection | itself dispatch anything |

- **An ack is not progress.** The no-progress breaker (§12.6) counts ticks without a **`review`**, so an endless ack loop still trips it. A phase advances on a persisted decision or not at all.
- **Idempotency is by digest, not by arrival.** Every receipt carries `--op-id` and its payload's sha256 lands in `note_op_ids` (§6): replay of the identical payload is a no-op exit 0; the same id with a different payload is exit 6, nothing written. Wrong `--attempt` ⇒ exit 6 (fenced, §12.2).
- **Results are exact:** exit 0 + the row's new `(attempt, phase, claim.state)` on stdout; 3 unknown task; 4 malformed queue; 5 stale `--if-*`; 6 fenced/duplicate-conflict; 2 missing required field. Nothing partial is ever written.

## 13. First handoff (r3, corrected in r3.1)

Approve this document once, and the first coder starts on **exactly one file: `bin/tq-write.py` (P1)** — r3 said "P1 alone" while listing two files, which r3.1 splits: `bin/init/manifest.mjs` is **P11**, a different file with a different owner that rides in the same PR (T96 goes red the moment a `bin/` file lands unlisted). P1 is new, so it collides with nobody including #1133, and every other loop piece depends on it. Its delta over r2: the §12.8 verbs and structs, the `spawn`/`inject` split, and the `note_op_ids` digest-map fix (§6).

**Order after that:** P1 (+P11) → P3 → P7 → **P9** → P10. P2/P4/P5/P6 stay parallel-safe and unchanged from r2.

**Blockers, as measured facts rather than open questions:** none for P1. P7 needs `src/dispatch/cli.ts` **free of a concurrent editor** — a scheduling reservation for the orchestrator, not a content dependency on #1133 F3 (§10). P9 needs P7 because the loop's dispatch path is the exit-11 gate. #1128 owns whether an inject reaches a turn — this design does **not** depend on that being fixed, because progress is measured by a `review` receipt, but its resolution is what would let the wake retry count drop.

**Bounded defaults chosen here so no further approval round is needed** (change any by saying so, none needs a question): loop off by default; 1 dispatch/tick; 2 attempts/phase; 12 dispatches/grant; 30-minute phase deadline (the registry's existing value); 2 re-wakes then `PAUSED`; grants scoped **per chain**, not one standing loop grant. **This document creates no automation** — it is a design contract, and every behaviour above exists only once P1–P10 are written, tested and merged.
