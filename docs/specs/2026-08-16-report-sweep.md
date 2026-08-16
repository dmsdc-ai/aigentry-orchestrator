# SPEC — `report-sweep`: a durable pull-side cursor over `~/.telepty/shared` (#904 + #743)

**Status**: awaiting GO. Phase 1 of sw904 (SPEC FIRST). No implementation lands until the
orchestrator replies.

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
state/dispatch/inbox/<YYYY-MM-DD>-<track>-<sha8>.md      # classified
state/dispatch/inbox/unclassified/<YYYY-MM-DD>-<sha8>.md # everything else
```

- `<YYYY-MM-DD>` — **UTC date of the ref's mtime**, not of the sweep. The filename then
  says when the report was written, which is the fact an operator wants, and a re-emit
  after midnight cannot produce a second path for the same sha.
- `<sha8>` — first 8 chars of the sha.
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

### 4.1 Track resolution

Tracks are derived from `state/dispatch/active.json`: for every `dispatches[].assigned.sid`,
the candidate set is `{sid, sid.split("-")[0]}`, keeping only candidates of length ≥ 3 (a
2-char prefix like `fB` matches noise). Candidates are tested longest-first as plain
substrings of the 400-byte head; the first hit wins, so the full sid beats its own prefix.

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

| id | asserts |
|---|---|
| **T106** | two refs written in the same second, one sweep → **both** copied to the inbox and both printed. This is the sibling-drop defect from §1.1 |
| **T107** | crash between the writes, simulated by deleting the cursor after a successful sweep → a second sweep leaves **exactly one** inbox copy per sha (idempotent by sha), and the inbox file count is unchanged |
| **T108** | a ref older than `last_mtime_ms - 5min` is **not** re-emitted; a ref inside the overlap window is scanned again but de-duped by `seen` |

`EXPECTED_GUARDS` in `tests/dispatch/run-all.sh`: **103 → 106**. cl899 is in flight with
T105 and may land first; if it does, the number is rebased onto whatever `main` carries —
the count follows the tree, it is not defended.

## 9. Security

Path traversal is the live hazard: both path segments come from untrusted-ish input
(`sha8` from a filename, `track` from JSON). Both are sanitised to `[A-Za-z0-9._-]` with
every other byte dropped, then length-capped (track 48), before any `path.join`. A segment
that sanitises to empty becomes `unknown`. `snyk_code_scan` → 0 new findings is a gate on
this task.

## 10. Baseline (Rule 39)

Measured in this worktree before any change: `npm test` **225/225**;
`bash tests/dispatch/run-all.sh` **103/103**, skip set `T16 T48 T95`.

## 11. Explicitly NOT in scope

- telepty-side hold-and-redeliver (#617).
- Any change to the live daemon on :3848, `~/.telepty/config.json`, or the `orchestrator`
  session.
- Porting `bin/session-reconciler.sh` (#899 T2c — another worker owns it).
- Reading the inbox. This task delivers reports *into* a durable place; who drains it and
  when is the orchestrator's turn loop, unchanged here.
