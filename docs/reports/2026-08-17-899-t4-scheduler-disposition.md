# #899 tranche 4 — `bin/dispatch-cleanup-scheduler.sh` → TypeScript: DISPOSITION

Phase 1 deliverable (sc899). Nothing is implemented yet; this is the measured plan
the implementation is held to. Every row was read out of the file or executed
against it, not out of prose (Rule 39).

Target re-measured — **231 lines, 10 functions, ZERO sourced libs**. The spec's
row (`docs/specs/2026-08-16-workspace-host-port.md:500`: `231 | 3 | 3 | 6`) is a
starting point and two of its three counts do not survive measurement:

| spec column | spec says | measured | evidence |
|---|---|---|---|
| LOC | 231 | **231** ✓ | `wc -l` |
| `src/` consumers | 3 | **1 real** + 2 comment-only | real: `src/reconciler/cli.ts:75,1317-1318` (`tick`). Prose only: `src/cleanup/cli.ts:6`, `src/reconciler/usage.ts:20` |
| `bin/` consumers | 3 | **1 file, 4 call shapes** | `bin/inject-handler.sh:34,119,134,147,153` |
| tests | 6 | **6** ✓ | T17 T19 T20 T21 T22 T76 |
| (functions) | — | **10** | `usage now_iso atomic_write_json is_keep_alive cmd_schedule cmd_cancel cmd_defer cmd_tick cmd_list main` |
| (sourced libs) | — | **0** | `grep -nE '^\s*(\.\|source)\s'` matches nothing |

Consequence of the zero: **this port has no `bash -c '. lib; fn'` door and no
`wh-cli.sh` verb at all.** The only doors are subprocess children (§1).

Dispositions, as the dispatch fixed them: **(a)** stays a subprocess, identical
argv · **(b)** subprocess door for a sourced bash lib · **(c)** in-process TS.

---

## 1. Subprocess children — `child | today | after T4 | why`

| child | today (line) | after T4 | why |
|---|---|---|---|
| `DISPATCH_REGISTRY_PY` = `bin/dispatch-registry.py` | `is_keep_alive`: `[ -x ]` gate, then `"$DISPATCH_REGISTRY_PY" get --sid <sid> --pointer keep_alive`, stderr dropped (`:72-76`) | **(a)** `spawnSync` identical argv, stderr `ignore`; **both fail-CLOSED arms preserved verbatim** — not executable ⇒ keep_alive, non-zero exit ⇒ keep_alive | python by design. This is the telepty#60 Stage A rewrite (`docs/designs/2026-07-30-…:274`): a corrupt registry must read as "do not clean up", never as permission. Re-implementing the read in TS would fork the schema validation. |
| `SESSION_CLEANUP_SH` = `bin/session-cleanup.sh` | `cmd_tick`: `[ -x ]` gate, then `"$SESSION_CLEANUP_SH" "$sid"`, non-zero → a stdout log line, tick continues (`:192-196`) | **(a)** identical argv, stdio inherited, same `[ -x ]` gate, same non-fatal arm | already TS behind its own shim (T2a, 988fb69). In-process would fork the Rule 28 protected-sid refusal and the #524 worker guard. |
| `python3` heredocs ×5 | `now_iso` (`:55`), schedule (`:97-114`), cancel (`:121-128`), defer (`:146-167`), tick due-filter (`:175-189`), `cmd_list` (`:205-214`) | **(c)** in-process TS | the scheduler's own logic: clock, ISO±seconds/minutes arithmetic, record shaping, one comparison. Exactly the class reserved for (c). **python3 stops being a direct dependency of this script**; it stays a transitive one through `dispatch-registry.py`'s shebang — which is why the PATH hardening stays in the shim (§4). |
| `mktemp` (`atomic_write_json` `:61`, tick snapshot `:174`) / `mv` / `rm -f` / `mkdir -p` | `:48,:61-63,:174,:200` | **(c)** in-process `fs` | shell plumbing. tmpfile+`rename` in the same dir keeps the atomicity property of pattern #114. |

Nothing else is spawned. No `telepty`, no `curl`, no `jq`, no `wh-cli.sh` — this
script never talks to the daemon, which is why the hp899 leak class cannot recur
here.

## 2. Sourced-lib functions

**NONE.** Measured: zero `.`/`source` lines in the file. §2 of the T2a/T2c
dispositions has no analogue here; T87's "exactly one `authToken` reader under
`bin/`" is untouched because this script never resolves a credential.

## 3. The 6 guards — sourced vs invoked

**SOURCED: ZERO.** Measured exactly as the dispatch prescribed:

```
grep -n '^\s*\(\.\|source\)\s.*dispatch-cleanup-scheduler.sh' tests/   → no match
```

**Consequence: T4 needs NO `__probe` subcommands.** The `__probe` surface stays
absent (T2c precedent; unlike T2a's T52 or T1's 12 `DISPATCH_SH_NO_MAIN` guards).

**INVOKED as a subprocess (6)** — all keep working through the shim unchanged:

| guard | how it invokes | what it pins |
|---|---|---|
| T19 `scheduler_schedule_and_tick` | `"$SCHED" schedule …` / `tick` | grace arithmetic (`12:00:00Z`+60s = `12:01:00Z`), `source` field, pre-deadline no-fire, at-deadline fire, pending drained to 0 |
| T20 `scheduler_cancel_and_defer` | `"$SCHED" schedule/cancel/defer` | cancel removes only its sid; defer ⇒ now+N min, `source=explicit-request`, `preempt_reason` |
| T21 `scheduler_keep_alive_skip` | `"$SCHED" schedule` | the keep_alive skip log **and** that nothing was written; and that a non-keep_alive sid still lands |
| T17 `lifecycle_3layer` | `"$SCHED" tick` + the real `bin/inject-handler.sh` | the 3-layer end-to-end: CLEANUP_REQUEST re-schedule → `source=explicit-request`, Layer-D timeout, EXTEND cancel, keep-alive opt-out, tick idempotence |
| T22 `reconciler_gc_root_and_sweep` | `SCHEDULER_SH="$SCHED"` → reached by `session-reconciler.sh --once` | that the reconciler's tick step reaches the real scheduler |
| T76 `corrupt_registry_fails_closed` | `"$SCHED" tick >/dev/null 2>&1 \|\| true` | that a tick against a corrupt `active.json` rewrites **no** bytes of it |

**Static-text assertions against the file: ZERO** (`grep -rn` over `tests/` for
`grep`/`wc`/`sed` on this path matches only T76's invocation). Unlike T2c —
`prune-status.sh:171`'s `grep -q 'HOME:='` — nothing here pins the shim's text, so
the `PATH` line stays in the shim for a runtime reason only (§4), not to keep a
guard green.

**Guards I expect to touch:** none of the 6. Adds: `tests/dispatch/T120_scheduler_parity.sh`
(new; every block re-runnable against the ORIGINAL bash at e2c3a36) and
`tests/dispatch/T121_scheduler_workspace_shim.sh` (new; T105/T111/T114/T117-style
two-layout dist resolution), plus `run-all.sh` `EXPECTED_GUARDS` 116 → 118 (+2
mine; the numbers are 120/121 as dispatched — `run-all.sh` counts guard *files*,
so the gap left for bb899's T118/T119 is not a mismatch). If I land second I
rebase and the REPORT says so.

## 4. Env seams

| seam | default | driven by | disposition |
|---|---|---|---|
| `DISPATCH_STATE_DIR` | `$REPO/state/dispatch` | all 6 guards via `tests/dispatch/lib.sh` | (c) `PENDING_JSON = <dir>/cleanup-pending.json` |
| `SCHEDULER_NOW` | live UTC | T17 T19 T20 T21 | (c) `nowIso()` returns it **verbatim**, no parse/reformat (T19 asserts arithmetic off it) |
| `DISPATCH_REGISTRY_PY` | `$SCRIPT_DIR/dispatch-registry.py` | default in all guards | (a) path override honoured identically; `SCRIPT_DIR` = `AIGENTRY_SHIM_SCRIPT_DIR` |
| `SESSION_CLEANUP_SH` | `$SCRIPT_DIR/session-cleanup.sh` | T17 T19 (fake recorder) | (a) same |
| `PATH` | hardened `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH` (`:38`) | no guard | **stays in the shim, in bash** (dispatch.sh precedent). It is what puts `python3` on PATH for `dispatch-registry.py`'s shebang and `node` for the `session-cleanup.sh` child. Moving it into TS would leave the registry child of one process generation running with the caller's PATH. |
| `HOME` | inherited | — | no recovery line in this file (unlike the reconciler). Nothing to preserve. |

Side effect that is *observable and therefore contract*: `mkdir -p "$STATE_DIR"`
and the `[ -f ] || printf '[]\n'` seed run at load time, **before** argv is
looked at — so `--help` and an unknown verb both create the state dir and the
empty pending file. Preserved.

## 5. Entrypoint contract — measured, with `pinned by`

Executed against the original bash; `out`/`err` are byte-exact.

| # | invocation | rc | stdout | stderr | pinned by |
|---|---|---:|---|---|---|
| 1 | `--help` / `-h` | 0 | 37 lines = `sed -n '2,38p'`; **last line is `export PATH="/opt/homebrew/bin:…"`** | — | **nothing** → T120 |
| 2 | (no args) | **4** | the same 37 usage lines | — | **nothing** → T120 |
| 3 | `bogus` | **4** | the 37 usage lines | `unknown: bogus` | **nothing** → T120 |
| 4 | `schedule` / `schedule ""` | 4 | — | `schedule: <sid> required` | **nothing** → T120 |
| 5 | `schedule S --bogus v` | 4 | — | `schedule: unknown --bogus` | **nothing** → T120 |
| 6 | `schedule S --grace-seconds` (no value) | **1** | — | locale-dependent `$2: unbound variable` | **nothing** → T120 pins **rc + non-empty stderr only** (T116's precedent: pinning a localized shell string measures `LANG`) |
| 7 | `schedule S` (keep_alive=true) | 0 | `[scheduler] keep_alive=true for S — skipping Layer D schedule` | — | T21 (log + no write) |
| 8 | `schedule S --grace-seconds 30 --source custom-src --reason "r with spaces"` | 0 | `[scheduler] scheduled cleanup sid=S in 30s (source=custom-src)` | — | T19 (record fields); **the log line itself: nothing** → T120 |
| 9 | idempotence: `schedule S` twice | 0 | as above | — | T17 (a1) via inject-handler; direct: T120 |
| 10 | `cancel` | 4 | — | `cancel: <sid> required` | **nothing** → T120 |
| 11 | `cancel S` (S absent) | 0 | `[scheduler] cancelled pending cleanup for S` | — | T20 (removal); the absent-sid no-op: **nothing** → T120 |
| 12 | `defer` | 4 | — | `defer: <sid> required` | **nothing** → T120 |
| 13 | `defer S` (no `--minutes`) | 4 | — | `defer: --minutes required` | **nothing** → T120 |
| 14 | `defer S --minutes` (no value) | **1** | — | locale-dependent unbound | **nothing** → T120 (rc only) |
| 15 | `defer S --minutes 5 --reason more-work` | 0 | `[scheduler] deferred cleanup for S by 5m` | — | T20 (fields); log line: T120 |
| 16 | `defer S --minutes 5` (S **absent**) | 0 | as above; **creates** the record with `report_time=now`, `source=explicit-request` | — | **nothing** → T120 |
| 17 | `tick` (nothing due) | 0 | `[scheduler] tick fired=0` | — | T19 T17 |
| 18 | `tick` (due, cleanup rc≠0) | 0 | `[scheduler] cleanup non-zero for S` then `[scheduler] tick fired=1`; **record still dropped** | — | **nothing** → T120 |
| 19 | `tick` (due, `SESSION_CLEANUP_SH` not executable) | 0 | `[scheduler] tick fired=1` | `[scheduler] session-cleanup.sh not executable at <path>` | **nothing** → T120 |
| 20 | `tick` with a record whose `scheduled_cleanup_time` is unparseable | 0 | `fired=0`, record **kept** (python `continue`, `:186`) | — | **nothing** → T120 |
| 21 | `list` | **1** | — | a python `SyntaxError` | **nothing** → see D2 |

`tick` fires in the snapshot's array order, and drops each record by re-reading
and rewriting the file per sid (`cmd_cancel` at `:197`) — not one final write.
Preserved: a crash mid-tick leaves the already-cleaned sids dropped and the rest
pending.

## 6. Platform branches

**Zero `process.platform` branches planned.** The bash file has no `uname` /
`case $(os_type)` arm of its own — measured: `grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg'`
matches nothing. Enumerated candidates and where each actually lives:
`mktemp` (BSD vs GNU differ on bare `mktemp`, but both accept the explicit
`<path>.tmp.XXXXXX` template used here, and TS replaces it with `fs` anyway) ·
`mv` → `fs.renameSync` · `date`/UTC → `now_iso`'s python, becoming
`toISOString()` · the hardcoded `/opt/homebrew/bin` PATH prefix is a macOS-shaped
*string*, not a branch, and it stays in the shim byte-identical. Rule 26 holds
with no branch to name, same as T1/T1b/T2a/T2c/T3a.

## 7. Two latent defects — REPRODUCED not fixed (Rule 29)? **This is the HOLD.**

Both were executed against the original bash at e2c3a36, both are pre-existing,
neither is caused by the port. Rule 29 says reproduce and report. For these two
"reproduce" has a cost I will not decide alone.

### D1 — a non-numeric `--grace-seconds` / `--minutes` TRUNCATES the fleet's pending queue

```
$ SCHEDULER_NOW=… sched schedule sid-A --grace-seconds 60   # + sid-B
$ sched schedule sid-C --grace-seconds soon
ValueError: invalid literal for int() with base 10: 'soon'
rc=1
$ wc -c state/dispatch/cleanup-pending.json → 0        # sid-A and sid-B are GONE
```

Mechanism: `python3 - <<PY | atomic_write_json "$PENDING_JSON"` (`:97`, `:146`).
The writer half of the pipeline runs regardless of the producer's fate — `cat`
sees EOF, writes an empty tmpfile, and `mv` commits it. `pipefail` reports the
failure *after* the damage. Every subsequent read hits
`except Exception: pending = []`, so the loss is silent and permanent: every
scheduled Layer-D cleanup fleet-wide is dropped, i.e. **workers stop being
retired and nothing says so.**

Reachability is not theoretical. `bin/inject-handler.sh:130-134` builds
`--grace-seconds "$grace"` from `payload.grace_seconds` of an **unauthenticated,
uncorrelated inject envelope** (its own comment at `:104-105` says so) and calls
it as `>/dev/null 2>&1 || true`. One `CLEANUP_REQUEST` carrying
`grace_seconds: "soon"` wipes the queue with no operator-visible trace.

* **(i) reproduce it** — port the pipeline shape so a bad int still empties the file.
* **(ii) validate before writing** (**my recommendation**) — parse the integer
  first; on failure exit 1 with a message on stderr naming the flag and the bad
  value, and **touch no file**. rc stays 1, stdout stays empty, the only
  behavioural difference is that the queue survives. Named in the shim header
  (Rule 38) + a ticket for `inject-handler.sh` to validate at the trust boundary
  (that half is not mine — Rule 29).

Reasoning for (ii): Rule 29 protects behaviour a caller may depend on; no caller
depends on losing the queue, and the dispatch's own "shim fails loud, never
half-works" points the same way. Reproducing data loss deliberately in new code
is the kind of scope call the envelope reserves for you.

Not a separate defect, same family, **no change proposed**: `except Exception:
pending = []` appears in all 5 heredocs, so a hand-corrupted
`cleanup-pending.json` is silently replaced with `[]` on the next write — the
fail-OPEN that T76 forbids for `active.json`. Reproduced as-is; noted for the
same ticket.

### D2 — `list` has never worked, on any Python

```
$ sched list
  File "<string>", line 9
    print(f"{p.get(\"sid\",\"?\"):40s} …")
SyntaxError: unexpected character after line continuation character
rc=1
```

`cmd_list` (`:205-214`) puts `\"`-escaped quotes inside an f-string expression in
a single-quoted `python3 -c` — bash passes the backslashes through, and a
backslash in an f-string expression is a syntax error on every CPython (rejected
outright before 3.12; here 3.14.2). It fails at compile time, so it fails on an
empty queue too. Present since the file was created (b7829ec, ADR 2026-05-20).
**Callers: none** — no guard, no `src/`, no `bin/` invokes the verb; it is
operator-facing and documented at `:32-33` as "Pretty-print current pending
records".

* **(i) reproduce** — a TS `list` that exits 1 with a fake SyntaxError. Absurd on
  its face.
* **(ii) implement the format the code obviously intended** (**my recommendation**):
  `f"{sid:40s} scheduled={…} src={…}[ reason={…}]"`, exit 0. Named in the shim
  header + a ticket recording that the verb was dead for ~3 months.
* (iii) delete the verb. Rejected — `--help` documents it, and removing a
  documented verb is a bigger contract change than fixing it.

## 8. Deliverable file list (Rule 29 surface)

`bin/dispatch-cleanup-scheduler.sh` (→ exec shim over `bin/lib/node-shim.sh`) ·
`src/cleanup-scheduler/cli.ts` + `usage.ts` (new) ·
`tests/dispatch/T120_scheduler_parity.sh` + `T121_scheduler_workspace_shim.sh` (new) ·
`tests/dispatch/run-all.sh` (`EXPECTED_GUARDS` 116 → 118) ·
this file. **No manifest change**: `bin/init/manifest.mjs:22` already ships
`bin/dispatch-cleanup-scheduler.sh` and no bin file is added.
`bin/lib/workspace-host.sh` is NOT touched (T3b declined). `bin/inject-handler.sh`
is NOT touched (T5, and D1's trust-boundary half belongs to its own ticket).

## 9. HARD constraints acknowledged

Worktree only (`~/.aigentry/worktrees/sc899`, `feat/899-t4-sc899`). Merge is a
live deploy: `src/reconciler/cli.ts:1318` calls `tick` every 60s from launchd
against the main checkout, and `bin/inject-handler.sh` calls `schedule`/`defer`/
`cancel` on the dispatch path. The production daemon on :3848,
`~/.telepty/config.json`, the `orchestrator` session and launchd are untouched —
this script never contacts the daemon, so no notify/inject can leak from it
(hp899's class of accident is structurally absent here). Tests use temp state
dirs + recorder stubs exactly as the 6 existing guards do.

## 10. Baseline BEFORE (Rule 35)

`npm test` → **225 pass / 0 fail**. `bash tests/dispatch/run-all.sh` →
**guards 116, passed 116, failed 0, skipped 3 (T16 T48 T95)**. `npx tsc -p .` → clean.
