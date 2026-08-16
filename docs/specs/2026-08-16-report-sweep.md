# SPEC — `report-sweep`: a durable pull-side cursor over `~/.telepty/shared` (#904 + #743)

**Status**: implemented. GO given 2026-08-16 on the version at `cf44266`.

Two clauses of that version were **wrong against real data** and were changed during
implementation, both recorded inline below with the measurement that forced them:

- §4 `<sha8>` → the whole ref id. Truncating to 8 chars collided four real refs onto one
  inbox path and lost three reports (161 refs in, 160 files out).
- §4.1 track resolution grew from one source to three. Registry-substring alone put 48 of
  161 refs — including this task's own dispatch — on the junk track `aigentry`.

## 1. The defect this addresses (measured, Rule 38)

A worker reports with `telepty inject --ref <file>`. The bytes land in
`~/.telepty/shared/<sha>.md`; the inject itself may be silently dropped when the
orchestrator is busy (observed 2026-07-26 ×3; 2026-08-15 fl850 — report written 22:07,
noticed 22:48, a 41-minute loss window).

The orchestrator-side recovery today is an ad-hoc `find ~/.telepty/shared -newermt <time>`
whose `<time>` is a human-chosen marker. Two failure modes, both structural:

1. a watcher that exits on the FIRST match drops the sibling ref that arrived in the same
   window, and the re-armed marker then post-dates it **forever**;
2. there is no durable cursor and no structured inbox, so "did I already read this?" has
   no answer that survives a restart.

Telepty-side hold-and-redeliver (#617) is a different fix and is OUT of scope. This is the
pull side only.

## 2. Surface

One new subcommand on the TS tracker:

```
dispatch-tracker.sh report-sweep
```

No flags. Exit 0 always, except exit 3 (§6). Implementation in a sibling module
`src/tracker/report-sweep.ts`; `src/tracker/cli.ts` gains an import, a `case`, and the
`--help` line in `src/tracker/usage.ts`. Rule 29 — nothing else in that file is touched.

### Env seams (tests never read the real dirs)

| var | default | why |
|---|---|---|
| `TELEPTY_SHARED_DIR` | `$HOME/.telepty/shared` | the scan root; **read-only, never written or deleted** |
| `DISPATCH_STATE_DIR` | `<repo>/state/dispatch` | already exists in `cli.ts`; cursor, inbox and `active.json` all hang off it |
| `TRACKER_NOW` | wall clock | already exists; reused as "now" for the cold-start floor only |

## 3. Cursor semantics

`state/dispatch/report-cursor.json`

```json
{ "last_mtime_ms": 1755331234567, "seen": { "<sha>": 1755331234567 } }
```

- `<sha>` is the ref's basename without `.md` — the telepty content hash, and the only
  stable identity a ref has.
- **Overlap window** `OVERLAP_MS = 5 min`. A sweep considers every `*.md` whose
  `mtime >= last_mtime_ms - OVERLAP_MS`. The slack absorbs clock skew and same-second
  arrivals; `seen` is what makes the re-scan cheap instead of duplicative.
- **`seen` is the sole dedup ledger.** A candidate whose sha is in `seen` is skipped. The
  presence of an inbox file is deliberately *not* consulted — one ledger, one answer.
- `last_mtime_ms` advances to `max(previous, every scanned file's mtime)`. It never moves
  backwards.
- `seen` is pruned to entries with `mtime >= last_mtime_ms - OVERLAP_MS`. Anything older
  can never be re-scanned, so keeping it would grow the file without bound.
- **Cold start** (file missing or unparseable) seeds `last_mtime_ms = now - 24h` rather
  than `0`. Measured 2026-08-16: `~/.telepty/shared` holds 159 refs and 0 from the last
  24h, so a `0` floor would copy 159 already-handled reports into the inbox on first run
  and teach the operator to ignore it. 24h is a constant, not a knob (Art. 1).
- An unparseable cursor is treated as a cold start, not a crash: the sweep's job is to not
  lose reports, and refusing to run loses all of them.

### Write order — the durability rule

1. every new inbox copy is written (`atomicWrite`, `src/session/persistence`),
2. the `NEW` lines print,
3. **then** the cursor is written (`atomicWrite`).

A crash between 1 and 3 re-emits on the next sweep: the same shas are still absent from
`seen`, the same sha-derived inbox paths are rewritten with the same bytes, and the same
`NEW` lines print again. **Re-emit, never loss** — and never a duplicate inbox entry,
because the path is a function of the sha.

## 4. Inbox layout

```
state/dispatch/inbox/<YYYY-MM-DD>-<track>-<ref-id>.md      # classified
state/dispatch/inbox/unclassified/<YYYY-MM-DD>-<ref-id>.md # everything else
```

- `<YYYY-MM-DD>` — **UTC date of the ref's mtime**, not of the sweep. The filename then
  says when the report was written, which is the fact an operator wants, and a re-emit
  after midnight cannot produce a second path for the same sha.
- `<ref-id>` — the ref's basename, sanitised (§9). **CHANGED from this spec's `<sha8>`.**
  The id must be injective in the basename or the inbox loses what it exists to preserve,
  and 8 chars is not. Measured 2026-08-16 against the real shared dir: 5 of 161 refs are
  not named for a 64-hex content sha, and four of those are `rel-874-answer-v101-tag.md`,
  `rel-874-npm-auth-three-paths.md`, `rel-874-publish-auth-report.md`,
  `rel-874-release-workflow-report.md` — all four truncate to `rel-874-`, one inbox path,
  three reports silently overwritten. The sweep emitted 161 `NEW` lines and produced 160
  files. A digest suffix is appended only when sanitisation or the 96-char cap actually
  dropped information, so a real content sha still names its own file exactly.
  Post-change: **161 refs in, 161 files out, 0 colliding paths.**
- Content is a **verbatim byte copy**. No injected header: the sweep must not alter the
  evidence it is preserving.
- The source under `~/.telepty/shared` is never moved, modified or deleted.

### Classification (first 400 bytes only)

1. `/^# (REPORT|HOLD|SPEC)\b/m` → `kind` = the captured word.
2. else the head mentions a track (§4.1) → `kind` = `REF`. This is the arm that catches
   `# DISPATCH — sw904 (…)`, which is a real ref with a real track and no REPORT header.
3. else → **unclassified**: `kind` = `?`, filed under `inbox/unclassified/`.

A header match and a track match are independent: a `# REPORT — wh899` gets
`kind=REPORT` *and* `track=wh899`.

### 4.1 Track resolution — **three sources, not one**

The GO'd version resolved the track by substring-matching the registry vocabulary alone.
Measured 2026-08-16 over all 161 real refs, that is wrong twice over, so the rule is now
three sources in falling order of authority:

1. **`^track:\s*(…)`** — the dispatch-ref template's own field. The author stating which
   track this is outranks any inference from prose.
2. **the title token after the em-dash** — `# REPORT — tk899 (#899 …)`,
   `# DISPATCH — sl909 (#909): …`. Admitted only if it carries a digit (below).
3. **registry substring** — `state/dispatch/active.json`, for every
   `dispatches[].assigned.sid`, candidates `{sid, sid.split("-")[0]}`, tested
   longest-first so a full sid beats its own prefix. Still earns its place: a
   `# SPEC — rank-based decision ledger` names its track only in the body
   (`- **Task**: lg923 (#923)`), which nothing but a substring match will find.

**The digit rule.** A sid *prefix* (source 3) or a title token (source 2) is admitted only
if it contains a digit. Every real track id here carries one — `sw904`, `tk899`, `sl909`,
`sp902-916`, `wh899`, `lg923`, `ci1`, `t880`; every junk token observed carries none —
`aigentry`, `architect`, `fix`, `coder`, `acc`, `disp`, `rel`, `pub`, `diag`, `telepty`.
Full sids are always admitted, digit or not: a full sid is specific enough that finding it
means something. Without this rule, sids like `aigentry-…` and `architect-…` are on file
and those words appear in every ref's repo paths, so longest-first let the junk token win:
**48 of 161 refs came back on track `aigentry`, including this task's own dispatch**
(`# DISPATCH — sw904 …`, filed under `aigentry`).

Source 2 exists because the registry is an **incomplete** vocabulary and pretending
otherwise mislabels live work: `tk899` and `sl909` have open worktrees and current reports,
and neither sid is in `active.json`.

Measured over the same 161 refs, one source → three: refs with no resolvable track
**103 → 57**, refs filed unclassified **58 → 36**. The residual 36 are orchestrator→worker
decision injects (`# DECISION:`, `# RELAY`, `# MY CALL`, `# VERIFIED`) — no track, no
report header, and correctly unclassified rather than forced onto a track they lack.

Unresolved track → the literal token **`unknown`**, in both the filename and stdout.

*Deviation from the dispatch text*, which wrote `<track|?>`: `?` is not a filename-safe
segment, and one placeholder spelled two ways is how the two stop agreeing. One token,
both places.

## 5. stdout

One line per newly seen ref, nothing else:

```
NEW <track|unknown> <REPORT|HOLD|SPEC|REF|?> <repo-relative inbox path>
```

## 6. Exit codes

| code | meaning |
|---|---|
| 0 | swept (including "nothing new", and including "`TELEPTY_SHARED_DIR` does not exist" — a box without telepty is not a failure) |
| 3 | an inbox or cursor write failed. Fail loud (Art. Fail Fast): one stderr line naming the path and the errno; the cursor is NOT advanced |

A ref that cannot be *read* is filed as unclassified with a stderr note and does not fail
the sweep — one unreadable file must not stop the other nine from being delivered.

## 7. Reconciler wiring

`bin/session-reconciler.sh`, immediately after the existing step 0b `"$TRACKER_SH" check`
block, in that file's sourced-lib style:

```sh
if [ -x "$TRACKER_SH" ] && [ "$DRY_RUN" -eq 0 ] && [ "${AIGENTRY_REPORT_SWEEP:-1}" != "0" ]; then
  "$TRACKER_SH" report-sweep 2>/dev/null | while IFS= read -r l; do log "$l"; done || true
fi
```

Act-only (skipped under `--dry-run`, same as the tracker check) and best-effort. The `NEW`
lines go through `log` rather than `/dev/null` so the reconciler's own log records what was
delivered. The `AIGENTRY_REPORT_SWEEP=0` opt-out exists because #899 T2c is porting this
reconciler concurrently and another worker owns that file; the flag lets the call be
disabled without a revert if the two collide.

## 8. Guards (`tests/dispatch/`, RED first — Rule 35)

Renumbered T106–T108 → **T107–T109** on 2026-08-16: cl899 (PR 11) already claims T105 and
T106 (`T106_cleanup_cli_contract.sh`).

| id | asserts |
|---|---|
| **T107** | (a) two refs written in the same second, one sweep → **both** copied and both printed — the sibling-drop defect from §1.1. (b) two refs sharing an 8-char basename prefix → **both** survive, which is the `rel-874-*` loss in §4 |
| **T108** | crash between the writes, simulated by deleting the cursor after a successful sweep → the second sweep re-emits (that is the contract) but leaves **exactly one** inbox copy at the **same path**, and a third sweep with a healthy cursor is silent |
| **T109** | a ref older than `last_mtime_ms - 5min` is **not** re-emitted; a ref inside the overlap window is scanned again but de-duped by `seen`. Ends on a negative control: drop that sha from `seen` and the same file re-emits, proving the silence was the ledger's doing |

`EXPECTED_GUARDS` in `tests/dispatch/run-all.sh`: **105 → 108**. cl899 landed first
(`988fb69`, PR 11), taking main from 103 to 105 with T105/T106; this branch is rebased onto
it and adds three. The count follows the tree; it is not defended.

## 9. Security

Path traversal is the live hazard: both path segments come from untrusted-ish input
(the ref id from a filename, `track` from JSON). Both are sanitised to `[A-Za-z0-9._-]`
with every other byte dropped — dropped rather than escaped, because an escape leaves the
caller reasoning about encodings and a drop leaves nothing to reason about — then
length-capped (track 48, ref id 96) before any `path.join`. `.` and `..` survive that
character class intact, so they are rejected by name: they *are* the traversal. A segment
that sanitises to empty becomes `unknown`.

Because sanitisation is itself lossy, a ref id that was altered by it carries an 8-hex
SHA-256 suffix of the original name (§4) — otherwise two hostile names differing only in
dropped bytes would map to one inbox path, which is the §4 loss with an attacker behind it.

`snyk_code_scan` over `src/` → **0 issues**.

## 10. Baseline (Rule 39)

Measured in this worktree before any change: `npm test` **225/225**;
`bash tests/dispatch/run-all.sh` **103/103**, skip set `T16 T48 T95`.

After, rebased onto `988fb69` (cl899's T105/T106 included): `npm test` **225/225**;
`bash tests/dispatch/run-all.sh` **108/108**, skip set `T16 T48 T95` — unchanged, so
nothing went quiet to make room for the new guards.

End-to-end against the real `~/.telepty/shared` (read-only, throwaway state dir, forced
full backfill): **161 refs → 161 inbox files, 0 colliding paths, exit 0, empty stderr**,
and a second sweep prints nothing.

## 11. Explicitly NOT in scope

- telepty-side hold-and-redeliver (#617).
- Any change to the live daemon on :3848, `~/.telepty/config.json`, or the `orchestrator`
  session.
- Porting `bin/session-reconciler.sh` (#899 T2c — another worker owns it).
- Reading the inbox. This task delivers reports *into* a durable place; who drains it and
  when is the orchestrator's turn loop, unchanged here.
