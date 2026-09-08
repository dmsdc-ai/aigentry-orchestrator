# SPEC — #1136 workflow productionization: approval, notification, reap, ledger, release

**Status** design contract, no code written. **Source** `docs/reports/2026-09-08-workflow-efficiency-analysis.md` at `0541a29` (corrected revision; the pre-revision `55dc27d` claims are NOT used). **Tree** `5baeecf` = `main` at authoring time. **Owner** architect only; every file below is unwritten.

Findings addressed: F1 (approval retention), F3 (duplicate completion notice), F2+F5 (reap order and assignment state), F6 (ledger append). F4 (router ref header) is **#1133's**, not restated here.

## 0. Boundary against #1133 and #1128

**Owned here:** the `bin/` ledger writer, one `session-cleanup.sh` selector, `report-sweep` grouping, template policy, README/ship-set truth. **Owned elsewhere:** `src/dispatch/cli.ts`, `bin/model-router.mjs` and the `active.json` schema — including **all cap/quota counting** — are #1133's; inject delivery loss and modal capture are #1128's.

**No file in this spec is also in #1133's split** (`docs/specs/2026-09-08-model-router-production.md` §13: F1 profile, F2 router, F3 `src/dispatch/cli.ts`, F5/F6 fixtures+tests, F7 docs). #1133 §8.2 decides worker-vs-orchestrator cap accounting; **this spec changes no counting and sets no cap-demotion target** — a demotion when capacity is genuinely full is the cap working. Reserved exit codes: #1133 takes **10**; this spec takes **11** if a gate is ever added (§3, deferred). One registry writer stays `bin/dispatch-registry.py`.

## 1. The framework-reuse question, answered

**No new service, daemon, framework or dependency. One new file.** Every mechanism below is an added subcommand/flag on a primitive that already exists and is already on the release path:

| Need | Existing primitive | Why it fits |
|---|---|---|
| durable approval + task state | `state/task-queue.json` (1.72 MB, 1136 rows, indent-2, UTF-8 literal, trailing `\n`) | already reloaded every session; already the Rule 34 gate input (`src/dispatch/cli.ts` `TASK_QUEUE`) |
| locked atomic JSON write | `bin/dispatch-registry.py` (lock ctx `:168`, same-dir temp + fsync + rename `:255`) | idiom exists; copy it, do not invent one |
| inbound report capture + dedup | `dispatch-tracker.sh report-sweep`, `state/dispatch/report-cursor.json`, `state/dispatch/inbox/` (spec `2026-08-16-report-sweep.md`) | durable pull-side cursor already survives restart and already parses kind+track |
| session reaping with protections | `bin/session-cleanup.sh` → `src/cleanup/cli.ts` (protected sid `:45`, self/ancestor guard `:344`, `--keep` `:622`) | reuse guards verbatim; add a selector, not a policy |
| release proof | `.github/workflows/release.yml`, `tests/packaging/{T96,smoke-init.sh}` | already packs, publishes, reads back from the registry |

The **one** new file is `bin/tq-write.py` (§6): the three existing `bin/tq-*.sh` are read-only, so there is no writer to extend, and approvals/status/owners/notes all need the same lock + atomic rename. One writer, one lock — three scripts would be three lock implementations (Art. 1).

## 2. Measured current contracts

| Fact | Where |
|---|---|
| ledger is indent-2, non-ASCII **unescaped**, one trailing newline; notes are one string joined by ` \| ` / ` \|\| ` | `state/task-queue.json` |
| `note` append today re-emits the whole prior note through model output (#1132 note reached 3,465 B in 3 appends) | report F6 |
| statuses in use: pending 298, done 775, in_progress 21, blocked 10, blocked-by-observation 10, awaiting-user 9, delegated 10, cancelled 3 | ledger snapshot 2026-09-08 |
| 80/80 dispatch records carry `outcome.state="unknown"`, `capability.outcome_protocol="unavailable"` (`stage_b_deferred_to_0.9.0`) — **no completion-signal path exists**; records key on `assigned.sid`, never a task id | `state/dispatch/active.json` |
| template requires a HOLD at *every* phase boundary (`:109`) and a REPORT at the last (`:75-76`) → both fire on a final approval-needing phase | `docs/templates/dispatch-ref-template.md` |
| sweep dedups by ref content sha only; a HOLD and a REPORT for one event are two shas | report-sweep spec §3 |
| `bin/**` is enumerated file-by-file in `bin/init/manifest.mjs`; T96 assertion 4 fails unless that count equals `git ls-files bin` | `tests/packaging/T96_ship_set_agreement.sh:81-85` |
| `README.md` is **generated** from `README.tmpl.md` + `ecosystem.json`; `gen-readme.mjs --check` exists and is wired to no test | `scripts/gen-readme.mjs`, `.github/workflows/readme-regen.yml` |

## 3. C1 — approval scope that survives reload

Append-only `approvals` array on the owning task row. Written **only** by `tq-write.py approve|revoke`.

```json
{"id":"ap1136-3f9c21a8","scope":"<one line, the granted action>","phases":["spec","impl"],
 "granted_at":"2026-09-08T13:04:11Z","provenance":{"source":"user","quote":"<verbatim>","ref":"<ref-id|transcript ts>"},
 "status":"active","supersedes":null,"revoked_at":null}
```

- `--scope` and `--quote` are **required**; missing either ⇒ exit 2, nothing written. There is no keyword/prose path that mints a grant — the helper never reads free text and infers one.
- **Never widened.** `approve` on a row that already has an `active` record writes a *new* record with `supersedes:<old id>` and flips the old to `superseded`. An existing record is never edited in place.
- `revoke <approval-id> --quote` ⇒ `status:"revoked"`. `revoked`/`superseded` never return to `active`.
- **Legacy** rows have no `approvals` key. Absent ≠ denied and ≠ granted; it is **unrecorded**, and every existing path behaves exactly as today. No status value changes meaning.
- Read path: `tq-write.py approvals <task>` prints active records; `bin/tq-status.sh` gains one line per task with an active approval. This is what makes re-asking unnecessary after a reload.

**Deliberately NOT built:** a dispatch-side `--approval` gate. Nothing measured shows a dispatch made without approval — the measured defect is a *turn* that acknowledged and did not actuate, which no tool gate can force (§8). Adopt the gate only if a dispatch-without-active-approval is ever observed; it would be ~10 lines in `src/dispatch/cli.ts`, **serialized after #1133 F3**, exit 11.

## 4. C2 — one notification per completion event

Grouping in `src/tracker/report-sweep.ts`; cursor gains an `events` map beside `seen`, pruned on the same window. No new store, no change to what is copied.

- **Event key** `<task>/<phase>` (`<track>/<phase>` when no task; `-` for a missing phase). Parsed from the same head-400 window the sweep already reads: `#(\d+)` after `task:` and `^phase:\s*(\S+)`. **`kind` is recorded, never part of the key** — a HOLD and a REPORT for the same phase are one event, which is exactly the measured F3 pair. Identity is never text equality.
- **First sight of a key** ⇒ one line naming every ref in the group with its kind: `EVENT ah1132/#1132/build — REPORT <ref-a> + HOLD <ref-b>`.
- **A later ref on a known key** ⇒ `AMENDED <key> — <ref-id> (<kind>)`, one line. Never silent, never merged into the old line: corrections and changed evidence always surface.
- **Every ref is still copied verbatim to the inbox, unconditionally.** Grouping changes the notification only. At-least-once delivery stays permitted; re-emit-never-loss (report-sweep §3) is unchanged.
- Template policy (`docs/templates/dispatch-ref-template.md`): final phase sends **one** REPORT carrying `needs:`; HOLD stays intermediate-only; both lines must carry `task: #N` and `phase: <name>` so the key is computable. Instruction-only (§8) — the grouping above is what holds when a worker sends both anyway.

## 5. C3 — reap before the successor spawns

New selector `bin/session-cleanup.sh --reap-settled [--task <id>] [--keep <sid>]`. All existing protections apply unchanged: protected `orchestrator` sid, self/ancestor SIGTERM refusal, `--keep`, worker-session refusal.

A sid is **settled** only if both hold:

- **R (retention)** ≥1 inbox file resolves to this sid's track and the newest is `kind=REPORT` — the report of record is on disk before the session dies.
- **Q (quiescence)** the sid's `active.json` `lifecycle.state` is terminal. The implementer must enumerate the actual value set from `bin/dispatch-registry.py op_set_lifecycle` — **do not guess it**.

Not settled ⇒ **not killed**, one line saying which of R/Q failed, **exit 0** — so the command is safe to run unconditionally before every spawn, which is the whole ordering fix. Non-zero only on real error. An unrelated active worker can never be selected: it fails R or Q.

**R+Q prove the assignment ended and the evidence was retained. They do not prove the task is finished** — 80/80 records carry no outcome, so nothing here may infer completion. Accordingly, on a successful reap: `tq-write.py owner-remove <task> <sid>`; when `owners` empties and status is `delegated` ⇒ **`in_progress`**. **Never `done`.** Rows with no recorded `owners` (all rows today) are left untouched with an `UNOWNED` line. Owners are recorded by `tq-write.py owner-add` at dispatch time — in the ledger, **not** in `active.json`, whose schema #1133 F4 freezes.

> On the ledger snapshot: "no retained dispatch record" (#20, #28) means the history is absent, **not** that
> the task was never dispatched. Historical `delegated` counts are snapshots, not a target to drive to zero.

## 6. C4 — `bin/tq-write.py`

Python 3 stdlib only (Art. 17; python3 is already a hard dep of `bin/`). Subcommands: `note-append <id> --text S [--key K]` · `status <id> <value> --if-current <value>` · `owner-add|owner-remove <id> <sid>` · `approve|revoke|approvals` (§3).

- **Lock** `fcntl.flock` on `<queue>.lock`, copying `bin/dispatch-registry.py:168`. **Atomic** same-directory temp + `fsync` + `os.replace`, copying `:255`. A concurrent writer waits; no update is lost.
- **Format** `json.dump(indent=2, ensure_ascii=False)` + trailing `\n`. Pinned by an acceptance case, not by assumption (the tree contains one pre-escaped `\u` sequence — the load→dump round-trip test finds it).
- **Never rewrites old note text.** The prior note is read from disk; the caller supplies only the new segment. Appends as ` || <segment>`, matching today's separator.
- **Idempotent append** `--key K` prefixes the segment `[K]` and no-ops (exit 0) if `[K]` is already present in the note. No schema change, and the key stays human-visible.
- **Refusals** unknown task id ⇒ exit 3; malformed queue JSON ⇒ exit 4, **no write**; `status` without a matching `--if-current` ⇒ exit 5, no write.
- **Ship set**: adding this file **requires** the matching `bin/init/manifest.mjs` entry or T96 assertion 4 fails and the release is blocked. Non-optional.

## 7. C5 — npm, install and README truth

**Unverified here:** the registry contents. This spec asserts nothing about what is published; the builder phase runs `npm view @dmsdc-ai/aigentry-orchestrator versions --json` and reports the actual answer.

Measured conflict: `README.tmpl.md:5,19` and `ecosystem.json` (`package:"aigentry-orchestrator"` — missing the `@dmsdc-ai/` scope, `version:"—"`, `published:false`) say unpublished, while `release.yml` publishes on a `v*` tag and `.github/workflows/readme-regen.yml`'s own header states the package IS published.

- **N1** Fix `README.tmpl.md` + `ecosystem.json`; **never** `README.md`, which is generated. Wire `node scripts/gen-readme.mjs --check` into the test path so drift fails loudly.
- **N2** Every install/upgrade/uninstall claim names the exact command and the test that exercises it. An untested claim is deleted, not softened. `bin/init/cli.mjs` has `init [--workspace|--yes|--dry-run|--force|--upgrade]` and `--version` — **there is no `uninstall` verb**, so no README may imply one.
- **N3** Release gates. Existing and kept: T96 ship-set agreement, `smoke-init.sh` (real tarball, throwaway npm prefix + throwaway `HOME`, so a repo-relative or author-home assumption fails there), the registry shasum read-back and the clean `npx --version` check in `release.yml`. **Added to `smoke-init.sh`**: (a) upgrade preservation — seed a workspace, write a sentinel under `state/`, run `init --upgrade`, sentinel intact (`cli.mjs:295-297` claims this; assert it); (b) uninstall preservation — `npm uninstall -g` from the throwaway prefix leaves the workspace and its `state/` intact.
- **N4** `tests/packaging/*.sh` run **only** in `release.yml`, never in `npm test`. Say so; do not let anyone expect a local `npm test` to catch (a) or (b).
- **N5** Publication is the builder's, after tests, under the standing authorization — no repeat generic permission prompt, and **no automated restart of the live orchestrator**. A missing credential is a factual HOLD naming the secret by name only; its value is never printed (`release.yml` already tests emptiness only).

## 8. Enforceable vs instruction-only

A runtime cannot make an LLM emit a tool call. The split is stated so nobody claims otherwise:

| Enforceable (a tool refuses, or the data cannot express the bad state) | Instruction-only (guidance; measured by A1/A2/A3) |
|---|---|
| grant requires `--scope`+`--quote`; scope never widened in place; revoked never reactivates | act in the turn that received approval |
| `--reap-settled` cannot kill a non-settled or protected session | run `--reap-settled` before the successor spawn |
| reap never sets `done`; `owners`-empty only reaches `in_progress` | do not re-ask inside an active recorded scope |
| locked atomic ledger writes; `--key` idempotence; malformed input writes nothing | final phase sends one REPORT with `needs:` |
| sweep emits one line per event key and copies every ref regardless | — |

## 9. Acceptance cases

Each reproduces the recorded case **before** the fix, from fixtures — no live daemon, no live ledger.

| # | Case | Before | After |
|---|---|---|---|
| K1 | the four measured HOLD/REPORT pairs as fixture refs (ah1132 21:25:32+21:25:46, in1128 21:32:31+21:32:45, ah1132 21:35:36+21:35:37, mr1133 21:46:22+21:46:44) | 8 `NEW` lines | 4 `EVENT` lines, 8 inbox files |
| K2 | a 5th ref on an already-notified key; and a ref with no `task:`/`phase:` | — | 1 `AMENDED` line, file copied, first line untouched; missing fields fall back to `<track>/-`, never dropped |
| K3 | reap a sid whose newest inbox ref is a HOLD (R fails) / whose lifecycle is non-terminal (Q fails) | — | no kill, reason printed, exit 0 |
| K4 | `--reap-settled` with the protected `orchestrator` sid live, and with an unrelated active worker live | — | neither selected |
| K5 | reap the last owner of a `delegated` task | — | `in_progress`; a second run is a no-op; `done` never written |
| K6 | reap when `owners` absent (every row today) | — | status untouched, `UNOWNED` line |
| K7 | append 40 B to #1132's 3,465 B note | caller supplies the whole prior note | caller supplies only the segment; note grows by exactly the segment |
| K8 | same `--key` twice; two concurrent `note-append` on one row; two on different rows | — | one segment; both segments; both rows — no lost update |
| K9 | load→dump the real queue with no edit | — | byte-identical (pins indent-2 / newline / non-ASCII) |
| K10 | malformed queue JSON; unknown task id; `status` with a stale `--if-current` | — | exit 4/3/5, **file unchanged** |
| K11 | `approve` without `--quote`; `approve` twice with different scopes; `revoke` then read | — | exit 2 nothing written; second supersedes, first not widened; revoked never active |
| K12 | reload: read `approvals` from a fresh process | — | scope, phases and provenance intact |
| K13 | `gen-readme.mjs --check` against a tree whose `ecosystem.json` changed | — | non-zero |
| K14 | `init --upgrade` over a seeded workspace; `npm uninstall -g` after it | — | `state/` sentinel intact in both |

## 10. File split, ownership, edges

| ID | File | Change | Role | Depends on |
|---|---|---|---|---|
| P1 | `bin/tq-write.py` **(new)** + `bin/init/manifest.mjs` (one entry) | §6 §3 | coder-A | — |
| P2 | `src/tracker/report-sweep.ts`, `src/tracker/usage.ts` | §4 grouping + `events` in the cursor | coder-B | — |
| P3 | `src/cleanup/cli.ts`, `src/cleanup/usage.ts` | `--reap-settled` (§5); calls P1 as a subprocess | coder-C | P1 |
| P4 | `docs/templates/dispatch-ref-template.md`, `docs/templates/dispatch-ref-checklist.md` | §4 policy lines | coder-B | — |
| P5 | `README.tmpl.md`, `ecosystem.json`, `tests/packaging/smoke-init.sh` | §7 N1–N4 | coder-D | — |
| P6 | new tests under `tests/dispatch/` + `tests/packaging/` | K1–K14 | tester | P1–P5 |

**Parallel-safe:** P1 ∥ P2 ∥ P4 ∥ P5 (disjoint files). **Serialized:** P3 after P1 (subprocess contract); P6 after all. **No file here is touched by #1133** (§0). P2 and P3 are TypeScript: `tsc -p .` must run before any guard, and `npm test` refuses a stale `dist/` (`scripts/run-tests.mjs:37-47`).

**Runner inclusion — verified, not assumed.** `npm test` auto-collects `dist/tests/**/*.test.js`, so a new `.test.ts` needs no registration. A new **shell** guard under `tests/dispatch/` is globbed by `T*.sh` but `tests/dispatch/run-all.sh:52` pins `EXPECTED_GUARDS=135` — **the count must be bumped in the same commit or the suite fails**. `tests/packaging/*.sh` are invoked only by `release.yml`. Highest existing id is **T150**; **the orchestrator reserves the new ids — this session does not.**

## 11. Rollout, rollback, unknowns

Stage 1 P1 (additive; nothing reads the new fields yet) → 2 P2+P4 (notification only) → 3 P3 (reaping) → 4 P5 (release truth) → 5 publication by the builder after tests. Each stage lands behind K-cases and is independently revertable: P1/P2/P4/P5 are additive, and P3 is one selector — reverting it restores today's manual order. No migration: `approvals`/`owners` are absent everywhere until first written.

**Unmeasured, and to be measured by the implementer, not guessed:** the terminal `lifecycle.state` set (§5 Q); the registry contents (§7); whether every historical ref carries a parseable `task:`/`phase:` (§4 falls back to `-` when not). **Not claimed anywhere in this document:** token or cost figures, worker idle-vs-busy ratios, LOC, and timing targets — the corrected report withdrew those inferences and this spec does not reintroduce them. **Open for the orchestrator:** the reserved test-id block (§10), and whether `owner-add` is added to the orchestrator's dispatch routine now or when P3 lands.
