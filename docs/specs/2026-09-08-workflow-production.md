# SPEC — #1136 workflow productionization: approval, notification, reap, ledger, release

**Status** design contract, revision 2 after review of `7422cdb` (ISSUES, not approval). **Source** `docs/reports/2026-09-08-workflow-efficiency-analysis.md` at `0541a29`; the pre-revision `55dc27d` claims are not used. **Tree** `main` `5baeecf` at authoring time. **Owner** architect; no file below is written.

Findings addressed: F1 approval retention, F3 duplicate completion notice, F2+F5 reap order and assignment state, F6 ledger append. F4 (router ref header) is #1133's.

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
| r2: "`report-sweep` has no production caller" | **false** — `src/reconciler/cli.ts:1280-1288` runs it every tick and logs every line. The true, narrower claim is that no sweep result is **delivered into an orchestrator turn** | §2, §4 |

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
{"ev":"grant","id":"ap1136-3f9c21a8","at":"2026-09-08T13:04:11Z","scope":"<one line>","phases":["spec"],
 "supersedes":null,"provenance":{"source":"user","quote":"<verbatim>","ref":"<ref-id|transcript ts>"}}
{"ev":"revoke","id":"rv1136-0c41","at":"…","target":"ap1136-3f9c21a8","provenance":{…}}
```

- **Derivation** a `grant` is *active* unless a later event `revoke`s it or a later `grant` names it in `supersedes`. Nothing else. `tq-write.py approvals <task>` prints the derived view; the history is the record.
- **Independent scopes coexist.** `supersedes` is explicit and single-target: a new grant never implicitly displaces unrelated active scopes.
- `--scope`, `--phases` and `--quote` are required on `grant`; `--target` and `--quote` on `revoke`. Missing any ⇒ exit 2, nothing written. The helper never reads free text and infers a grant — there is no prose or keyword path to approval.
- **Legacy** rows carry no `approvals` key: *unrecorded*, which is neither granted nor denied. Every existing path behaves exactly as today; no status value changes meaning.
- **Not built:** a dispatch-side approval gate. Nothing measured shows a dispatch made without approval; the measured defect is a turn that acknowledged and did not actuate, which no tool gate can force (§8). If one is ever wanted it is ~10 lines in `src/dispatch/cli.ts`, exit **11** (#1133 holds **10**), serialized behind P7.

## 4. C2 — notification grouping, and exactly what it can guarantee

**Identity is emitted by the producer, never inferred by the consumer.** The template gains one machine-readable line inside the first 400 bytes of every HOLD and REPORT: `event: <task>/<phase>/<attempt>` (e.g. `event: 1136/spec-revision/1`). This is required because measured refs carry `task:` inline after a pipe and carry **no** `phase:` at all — the `7422cdb` `^phase:` rule matched nothing, and its `<track>/-` fallback would have merged a track's unrelated events.

- **No `event:` line ⇒ no grouping.** The ref is notified individually, exactly as today. Absence of identity never produces a guess; legacy and third-party refs are unaffected. Ambiguity fails toward *more* notices, never fewer.
- **Same poll**, N refs sharing an `event:` ⇒ **one** `EVENT <id> — REPORT <ref-a> + HOLD <ref-b>` line. That is the measured F3 pair, whose refs are 1–22 s apart.
- **Later poll**, a further ref on a known id ⇒ one `AMENDED <id> — <ref-id> (<kind>)` line. **The guarantee is "at most one line per (event, poll)", not "one line per event ever":** a sweep cannot retract a line it already printed, and suppressing the later one would discard evidence. A HOLD and REPORT straddling a tick therefore yield 2 lines, and that is correct behaviour, not a defect. Cadence makes this concrete rather than theoretical: the poll is ~60 s (§2) and the four measured F3 pairs are 1–22 s apart, so pairs usually fall inside one tick — but the contract is stated at the weaker guarantee, not at the common case.
- **Duplicate vs correction** is decided on the copied bytes, not on kind: same `event:` + identical body sha ⇒ `DUP` (a redelivery); same `event:` + different body ⇒ `AMENDED`. Neither ever suppresses a file — **every ref is still copied verbatim to the inbox unconditionally**, and re-emit-never-loss (report-sweep §3) is untouched.
- State: an `events` map in `state/dispatch/report-cursor.json` beside `seen`, pruned on the same overlap window. A cursor loss is a cold start: identities are re-learned and lines re-emit — never lose, may repeat.
- **Consumer, precisely.** The sweep's lines **do** reach a durable artifact: the reconciler runs it each tick and tees every line to `state/dispatch/reconciler.log` (§2). So grouping has a real, inspectable effect today. What is absent is a **delivered turn notification** — nothing injects a sweep result into the orchestrator's turn, which is why the log existed and the 09-08 refs still waited for a human. Those are two different claims and this phase makes only the first: the *shape and durability* of the output. Turn delivery is #1128's repair and is **explicitly out of scope**; this spec proposes no daemon, injector or delivery change.

## 5. C3 — reap on a reviewed settlement, not an inferred one

The `7422cdb` predicate was circular: `src/cleanup/cli.ts:474` is itself what writes `cleaned`, and every other `RETIRED_LIFECYCLES` value is a failure or supersession — the registry's own comment says none of them says anything about the task. **No lifecycle value means "this worker finished."** Settlement is therefore an orchestrator decision that is **recorded, then verified**; cleanup actuates it and never infers it.

Sidecar, keyed by an id `active.json` already carries, so its schema stays frozen for #1133 F4 — this is the alternative that keeps identity safe without a schema bump: `state/dispatch/settlements/<dispatch_id>.json`

```json
{"dispatch_id":"2818c54c…","sid":"wf1136-architect","task":"1136","phase":"spec","event":"1136/spec/1",
 "artifact":{"inbox":"state/dispatch/inbox/<file>.md","sha256":"…","ref_mtime_ms":1788872351298},
 "continuation":"none","reviewed_by":"orchestrator","reviewed_at":"…Z"}
```

`bin/session-cleanup.sh --reap-reviewed [--task <id>] [--keep <sid>]` re-verifies **immediately before any side effect**:

- **V1 identity** `dispatch_id` is still the sid's current non-superseded record and its `assigned.sid` equals `sid` — a reused sid or a re-dispatch invalidates the settlement instead of inheriting it. Track substrings are not identity and are not used.
- **V2 artifact** the named inbox file exists and its sha256 matches — a stale or replaced report fails.
- **V3 continuation exclusion** no ref newer than `ref_mtime_ms` resolves to this sid, and `continuation` is `"none"`. A next-phase HOLD arriving after review therefore blocks the reap. Ambiguous resolution counts as failure.
- **V4 protections, unchanged** protected `orchestrator` sid (`cli.ts:45`), self/ancestor SIGTERM refusal (`:344`), `--keep`, worker-session refusal (`:642`).
- **Fail closed:** missing, stale or ambiguous ⇒ **exit 6, no kill, reason named**. Silence would hide a rejected reviewed decision. A sid with **no** settlement file is simply not a candidate — exit 0, nothing done — so a drain pass stays safe to run unconditionally.
- **Partial cleanup and races:** the three removal steps are already idempotent; a re-run re-verifies from scratch, and a settlement consumed by a completed reap is stamped `consumed_at` under the same lock, so a second pass is a no-op rather than a second kill.
- The three existing callers (`src/cleanup-scheduler/cli.ts:89`, `src/reconciler/cli.ts:77`, `src/session/open-session/cli.ts:384`) pass a bare `<sid>` and are **untouched** (Rule 29).

**Settlement ≠ completion.** V1–V3 establish that this *assignment* ended and its evidence is retained. On a verified reap: `tq-write.py owner-remove <task> <sid>`; when `owners` empties and status is `delegated` ⇒ **`in_progress`**, **never `done`**. Rows with no recorded `owners` are left untouched with an `UNOWNED` line. `owners` are written by the same `dispatch-stamp` call as W1 (§1) — in the ledger, not in `active.json`. Historical `delegated` counts are snapshots, and an absent dispatch record (#20, #28) means the history is missing, **not** that the task was never dispatched.

**Ordering, at its real strength.** Enforced: `--spawn-and-dispatch` drains verified settlements before it spawns and records `reap_before_spawn=ok|failed|none` in the existing no-task telemetry sink, so A3 is measurable. A drain failure **warns and proceeds** — the measured harm of a late reap is a routing demotion, not corruption, and refusing a dispatch over it is disproportionate. Instruction-only, named as such: *recording* the settlement is the orchestrator's reviewed act, and nothing can compel it. This drain also lives in `src/dispatch/cli.ts`, i.e. inside P7 (§1, §10).

## 6. C4 — `bin/tq-write.py`

Python 3 stdlib only (Art. 17; python3 is already a hard dep of `bin/`). Subcommands: `note-append` · `status` · `owner-add|owner-remove` · `grant|revoke|approvals` (§3) · `dispatch-stamp` (§1) · `focus`.

- **Operation identity is structured, not textual.** `--op-id <k>` is recorded in a dedicated `note_op_ids` array on the row; idempotence is exact membership in that array. Note prose is never scanned, so a `[K]` occurring inside old text can never be mistaken for an executed append.
- **Same id, different payload ⇒ exit 6, nothing written.** That is a caller bug, not a retry; a genuine second append needs its own id.
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

## 10. File split, ownership, dependency edges

| ID | Files | Change | Owner | Depends on |
|---|---|---|---|---|
| P1 | `bin/tq-write.py` **(new)**, `bin/init/manifest.mjs` | §6 §3 §1 helper + ship-set entry | coder-A | — |
| P2 | `src/tracker/report-sweep.ts`, `src/tracker/usage.ts` | §4 `event:` parse, grouping, `events` in the cursor | coder-B | — |
| P3 | `src/cleanup/cli.ts`, `src/cleanup/usage.ts` | §5 `--reap-reviewed`, V1–V4, settlement sidecar | coder-C | P1 |
| P4 | `docs/templates/dispatch-ref-template.md`, `docs/templates/dispatch-ref-checklist.md` | §4 `event:` line + one-final-REPORT rule | coder-B | — |
| P5 | `README.tmpl.md`, `ecosystem.json`, **`README.md` (regenerated)**, `tests/packaging/smoke-init.sh`, `.github/workflows/ci.yml` | §7 N1–N4 | coder-D | — |
| P6 | `bin/tq-focus.sh`, `bin/tq-status.sh` | route W2 through P1; surface derived approvals | coder-A | P1 |
| P7 | `src/dispatch/cli.ts` | §1 `taskLedgerUpdate()` → `dispatch-stamp`; §5 settlement drain before spawn | coder-B | P1, **#1133 F3** |
| P8 | new tests under `tests/dispatch/` + `tests/packaging/` | K1–K19 | tester | P1–P7 |

**Edges** `P1 → {P3, P6, P7}`; `#1133 F3 → P7` (same file — **serialized, never parallel**); `{P1…P7} → P8`. **Parallel-safe** P1 ∥ P2 ∥ P4 ∥ P5. P2, P3 and P7 are TypeScript: `tsc -p .` must run before any guard, and `npm test` refuses a stale `dist/` (`scripts/run-tests.mjs:37-47`). No file is edited by two owners, and no file is touched outside this table.

**Runner inclusion, verified.** `npm test` auto-collects `dist/tests/**/*.test.js` — a new `.test.ts` needs no registration. A new **shell** guard under `tests/dispatch/` is globbed by `T*.sh` but `tests/dispatch/run-all.sh:52` pins `EXPECTED_GUARDS=135`, which **must be bumped in the same commit**. `tests/packaging/*.sh` run in `ci.yml` and `release.yml`, not in local `npm test`. **Discovered id set:** the highest existing guard is `T150`, so `T151+` appears free — **reported as a discovery for the orchestrator to reserve; this session reserves nothing** (#1133 draws from the same range).

## 11. Rollout, rollback, unknowns

Stage 1 P1 (additive; nothing reads the new fields) → 2 P6 (writers converge on the transaction path) → 3 P2+P4 (notification) → 4 P3 (reaping) → 5 P7 **after #1133 F3** → 6 P5 (release truth) → 7 tests, build, pack and publication as **delegated phases after this spec is reviewed**. Each stage lands behind its K-cases and is independently revertable; P7 reverts to today's inline `taskLedgerUpdate()`. No migration: `approvals`, `owners`, `note_op_ids` and the settlements directory are absent until first written.

**Unknowns, to be measured by the implementer rather than assumed:** whether any non-orchestrator producer emits refs that would need an `event:` line; how the settlement sidecar interacts with registry `prune` (`bin/dispatch-registry.py:659`) once dispatch records age out; registry contents (§7). **Not claimed anywhere:** token or cost figures, idle-vs-busy ratios, LOC, timing targets, or any cap-demotion target — capacity limits remain legitimate and this spec changes no counting. **Future coders:** run `snyk_code_scan` (or `bin/snyk-scan.sh`) on changed first-party code, then fix and rescan before DONE; this doc-only phase is N/A. **Open for the orchestrator:** reserving the test-id block, and whether `owner-add` enters the dispatch routine at P1 or waits for P7.
