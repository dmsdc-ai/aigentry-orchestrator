# #899 tranche 4 — `bin/session-comms-auditor.sh` → TypeScript: REPORT

Track ca899, third and last of the tranche-4 three. Branch `feat/899-t4-ca899`
off `origin/main` @ 31384e7, worktree `~/.aigentry/worktrees/ca899`. Phase 1
disposition `4a5f678`, implementation `3b65c3c`.

The disposition
(`docs/reports/2026-08-17-899-t4-comms-auditor-disposition.md`) is the measured
plan; this is what landed against it.

---

## 1. Guard split — sourced vs invoked

**SOURCED: ZERO.** Measured exactly as the dispatch prescribed:

```
grep -rn '^[[:space:]]*\(\.\|source\)[[:space:]].*session-comms-auditor\.sh' tests/   → no match
```

**Consequence: NO `__probe` surface was added.** It would also have been the only
argv this script has ever read.

**INVOKED as a subprocess (2), both unmodified and both still green:**

| guard | how it invokes | what it pins |
|---|---|---|
| T45 `peer_delegation_flagged` | `"$AUDITOR"` (no args), `TELEPTY` from `lib.sh:45` | 2 out-of-policy events; the HOLD names both sids; the orchestrator lane is not classified; an in-policy fenced ask-request creates `<pairkey>__<thread>.json`; the peer-inject log is not consumed |
| T91 block (6) | `TELEPTY="$STUB_BIN/telepty" "$AUDITOR"` with an inject-always-fails stub | rc non-zero + `UNDELIVERED` on stderr (#835) |

**Static-text assertions against the file: ZERO**, so the `PATH` line stays in the
shim for a runtime reason only (§4), not to keep a guard green.

## 2. Doors

| door | disposition | what landed |
|---|---|---|
| `"$TELEPTY" inject --submit <orch-sid> "<text>"` | **(a)** subprocess, identical argv | `spawnSync`, stdio all `ignore`, non-zero **and** spawn-error both counted as undelivered. The HOLD text stays ONE argv element, so an attacker-controlled excerpt can never become a flag or a word split. T122 block C pins the argv byte-for-byte |
| `python3` heredoc (`:56-194`) + `python3 -c` (`:42`) | **(c)** in-process TS | classify · reconcile · telemetry · byte cursor · clock. **python3 is no longer a dependency of this script at all** — nothing keeps it transitively (no `.py` child, unlike the scheduler's `dispatch-registry.py`) |
| `mkdir -p` | **(c)** `fs.mkdirSync({recursive:true})` | failure arm preserved: rc 1 + a stderr line (T122 block J) |
| `fcntl.flock` | **deviation** | not reproduced — measured decorative, see §6 D3 |

**No `bash -c '. lib; fn'` door and no `bin/wh-cli.sh` verb**: the bash sourced zero
libs, so there was nothing to put behind one.

## 3. Contract table — `pinned by`, before and after

36 rows were executed against the original bash and are listed in full in the
disposition §5. **33 of them were pinned by nothing**; T122 pins them now. The
summary by block:

| block | rows | what it pins | passes on the ORIGINAL bash? |
|---|---|---|---|
| A | 1, 36 | dormant: no log (or a directory) ⇒ rc 0 and **nothing created** — the `[ -f ]` check is before `mkdir -p`, unlike the scheduler's load-time seed | yes |
| B | 2 | empty log ⇒ cursor `0`, no telemetry | yes |
| C | 3 | out-of-policy: the telemetry line's exact bytes, the `telepty inject` argv, cursor = log size, empty stdout | yes |
| D | 5, 9, 10, 17, 18, 19 | the round-counter file's **exact bytes**; two requests ⇒ `rounds: 2`; `PEER_ROUND_CAP` as the increment ceiling; an ask-reply spends no round; both markdown fallbacks, and that their `+1` is `0→1` and not to `round:N` | yes |
| E | 6, 20, 21 | both default orchestrator sids are the ignored lane, in both directions; the HOLD goes to the **first word** of `AIGENTRY_ORCHESTRATOR_SIDS` | yes |
| F | 7, 8, 24, 25 | the byte cursor in all four arms: re-tick idempotence, reset on a shrunk log, unusable cursor bytes ⇒ 0, no trailing newline | yes |
| G | 11, 29, 30, 32, 33 + 3 more | the §2.3 predicate matrix, including that a JSON `round: true` **reconciles** (python bools are ints) | yes |
| H | 12, 22 | junk/blank lines skipped; the excerpt collapses **then** truncates, to exactly 120 chars | yes |
| I | 4, 23, 28 | rc 5, the UNDELIVERED **count**, the summary line, the missing-binary arm, and that the cursor still advances | yes |
| J | 15, 16, 26, 27 | `--help` / `-h` / `bogus` are all ignored and the pass runs; uncreatable state dir ⇒ rc 1 + stderr; the fail-OPEN counter reset (reproduced) | yes |
| **K** | **31** | **D1** — a slashed `thread_id`, three ticks | **no — this is the fix** |
| **L** | **34** | **D1** — a non-object JSON line, three ticks | **no — this is the fix** |
| **N** | — | **D1** — a non-string `from`/`to` (a third poison shape, found while reviewing the port; see §6) | **no — this is the fix** |
| M | 13 | **D2** — the garbled HOLD, verbatim (reproduced) | yes |

**Parity is re-runnable, not claimed.** Verified in all four directions:

```
# A-J + M green on the ORIGINAL bash, K/L asserting the original's behaviour
git show 31384e7:bin/session-comms-auditor.sh > bin/.auditor-original.sh; chmod +x …
AUDITOR_UNDER_TEST=…/.auditor-original.sh COMMS_PARITY_ORIGINAL=1 bash tests/dispatch/T122…  → PASS
# the port
bash tests/dispatch/T122…                                                                   → PASS
# RED proof, both directions — K/L are not vacuous
AUDITOR_UNDER_TEST=…/.auditor-original.sh bash tests/dispatch/T122…   → FAIL[T122]: K (rc 1, traceback)
COMMS_PARITY_ORIGINAL=1 bash tests/dispatch/T122…                     → FAIL[T122]: K[original]
```

T123 was verified non-vacuous the same way: commenting out the shim's
`export AIGENTRY_SHIM_SCRIPT_DIR` makes it fail with
*"the pass wrote no telemetry under the WORKSPACE's state/"*.

## 4. Env seams

| seam | default | disposition | landed |
|---|---|---|---|
| `SESSION_COMMS_DIR` | `$REPO_DIR/state/session-comms` | (c) | + `telemetry.jsonl`, `.audit-cursor` |
| `AIGENTRY_PEER_INJECT_LOG` | `$REPO_DIR/state/dispatch/peer-injects.jsonl` | (c) | — |
| `AUDITOR_NOW` | live UTC | (c) | returned **verbatim**, no parse/reformat |
| `PEER_ROUND_CAP` | `3` | (c) | validity bound **and** increment ceiling; non-numeric ⇒ rc 1 before any write |
| `AIGENTRY_ORCHESTRATOR_SIDS` | 2 values | (c) | `split(/\s+/)` for the ignored lane, `split(" ")[0]` for the inject target — the bash used `.split()` and `${%% *}` respectively, which differ, and both are reproduced |
| `TELEPTY` | literal `telepty` | (a) | subprocess |
| `SCRIPT_DIR`/`REPO_DIR` | `$(dirname $BASH_SOURCE)` / `..` | `AIGENTRY_SHIM_SCRIPT_DIR` | **load-bearing** — the two defaults above hang off it and a reconciler tick passes neither, so a root derived from `dist/` would make every workspace audit the installed package's log and report a clean pass. T123 blocks A and B |
| `PATH` | hardened | **stays in the shim, byte-identical** | it resolves the literal `telepty` for the node process's child, and launchd → reconciler runs with a minimal PATH |

**Named tension, pre-existing, mentioned not changed (Rule 29):**
`bin/session-cleanup.sh:34-41` records that a hardcoded `/opt/homebrew/bin` prefix
is exactly what made task #400 pick a stale homebrew `telepty` against an older
daemon. This script has carried that prefix since #533 **and** runs `telepty`, so
the same hazard applies to it. Removing the prefix is a separate call with its own
blast radius. Both guards are immune either way because `tests/dispatch/lib.sh:45`
exports an absolute `TELEPTY`, which wins over PATH — and this host does have a real
`/opt/homebrew/bin/telepty` installed, so that belt is what keeps the suite off it.

## 5. Platform branches

**ZERO.** `grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg|sw_vers'` over the bash
matched nothing — there was no OS arm to enumerate. Candidates and where each went:
`mkdir -p` → `fs.mkdirSync({recursive:true})` · `os.replace` → `fs.renameSync` ·
UTC clock → `toISOString()` · byte offsets → `statSync().size` + a Buffer slice ·
`fcntl.flock` → §6 D3 · the `/opt/homebrew/bin` prefix is a macOS-shaped *string*,
not a branch, and stays in the shim. Rule 26 holds with no branch to name, same as
T1/T1b/T2a/T2c/T3a and both sibling T4s.

## 6. Defects — one fixed, two reproduced, two deviations named

### D1 — FIXED on the orchestrator's GO

One untrusted peer-inject line permanently disabled the guardrail. **Three** poison
shapes, all reachable without authentication — the disposition found two, and the
third turned up while reviewing the port:

* a line that is valid JSON but **not an object** — `json.loads` succeeds, so the
  `try/except` written to skip bad lines never fires, and `rec.get` raises one line
  later (`bash :171`);
* an envelope whose **`thread_id` contains `/`** — the state path was built from it
  unvalidated (`bash :135`), which is also a path-traversal vector into
  `state/session-comms`. `bin/ask.sh:179` builds the same path from an unvalidated
  `--thread`, so a human typing `899/t4` was enough;
* a **non-string `from` or `to`** — `"__".join(sorted([rec_from, rec_to]))`
  (`bash :179`) raised `TypeError: '<' not supported between instances of 'str' and
  'int'` on `{"from":123,…}`. Neither the record read nor the state path: the
  pairkey build. Found late, which is itself the argument for the fix over a
  reproduce — three shapes in one 226-line file means the enumeration was never
  going to be complete, and the fault isolation covers the ones nobody found.

Under `set -e` the traceback killed the pass **before the cursor was written**.
Measured over three consecutive ticks:

```
tick 1: rc=1  cursor=ABSENT/151  telemetry_lines=1
tick 2: rc=1  cursor=ABSENT/151  telemetry_lines=2
tick 3: rc=1  cursor=ABSENT/151  telemetry_lines=3
--- post-poison violation ever audited? --- 0
--- a brand-new violation, appended --- rc=1  audited: 0
```

So: the guardrail was dead for every later inject, **and** the pre-poison violation
re-injected the same HOLD into the orchestrator inbox once a minute forever, with
`src/reconciler/cli.ts:1293` folding it all into one
`ERR comms-auditor non-zero (continuing)` line.

**Landed:** each record classifies inside its own `try/catch` — an unexpected throw
emits `peer_audit_record_skipped` and the pass continues — the **cursor still
advances**, and `inPolicy()` refuses a `thread_id` containing `/` (or equal to
`.`/`..`) as the malformed envelope it is, so it is escalated *and* the state path
can no longer name a file outside `SESSION_COMMS_DIR`. A non-string sid reads as `""`
rather than crashing (which then meets D2's reproduced field collapse, consistently
with block M). Rows 1-30 and 32-36 are byte-unchanged; rows 31 and 34 become rc 0
plus a HOLD / a recorded skip. T122 blocks K, L and N — three ticks each for K and
L — asserting each side's behaviour under `COMMS_PARITY_ORIGINAL`.

### D2 — REPRODUCED

An empty `from` or `to` collapses the tab-delimited HOLD fields (tab is IFS
*whitespace*), so the HOLD reads
`from: orphan body | to:  | excerpt: ` while the telemetry line stays correct.
Reproduced deliberately — `holdFields()` re-implements the collapse — because the
HOLD wire text is this script's contract with a human reader and no record shape
telepty writes lacks `from`/`to`. T122 block M pins it verbatim so it can neither be
quietly "fixed" nor lost.

### D3 — DEVIATION: the `flock` is not reproduced

`bash :51` claimed "flock-atomic, matching ask.sh". Measured, 3/3 identical runs,
one `rounds += 1` each side:

```
auditor rc=0  blocked_for=1.53s     # it DID wait on the lock
final state:  "rounds": 1           # expected 2; the peer's write is GONE
```

`os.replace` swaps the **inode**, so the waiter is queued on the orphaned file and
reads pre-increment content. The lock buys a wait and no exclusion, on either side —
`bin/ask.sh:196-248` is the same shape. Node core has no `flock(2)`
(`src/session/persistence/index-lock.ts:1-6` is the repo's Article 17 precedent),
and a *correct* sidecar lock added here alone would exclude concurrent auditor
passes (there is one tick at a time: nothing) while still not excluding `ask.sh`.
**Landed: tmp + `renameSync`, no lock** — same observable bytes, same narrow
lost-update window, named in the shim header. The two-writer fix is the
orchestrator's ticket (`ask.sh` + auditor together, `index-lock.ts` pattern).

Same family, also reproduced, **no change**: `reconcile()`'s `except Exception: st = {}`
silently replaces an unparseable `<pairkey>__<thread>.json` with a fresh `rounds: 1`
record (T122 block J3) — the fail-OPEN that T76 forbids for `active.json`. The same
`except` is in `bin/ask.sh:200-201`, so fixing one side would only move which
process resets the counter. Belongs to D3's ticket.

### D4 — DEVIATION: the excerpt of a non-string body

python rendered `str(body)`, i.e. `{'kind': 'ask-request'}`. JS cannot reproduce
that class in general — `JSON.parse` collapses `1.0` and `1`, so `str()`'s `"1.0"`
is unrecoverable, and faking dict/`True`/`None` while silently missing floats would
be a worse lie than one documented line. **String bodies — the only shape telepty's
log is known to write, and 34 of 36 contract rows — are byte-identical.** A
non-string body renders JSON-style. Same root cause, one more consequence: a JSON
`"round": 1.0` was out of policy under python and is in policy here; nothing emits a
float round (`bin/ask.sh` writes an int).

### One more deviation, cheap and named

The bash took `os.path.getsize()` and then read to the real EOF, so lines appended
in between were audited but not covered by the cursor it wrote, and were re-flagged
next tick. The port consumes exactly the bytes the cursor will claim
(`subarray(start, size)`), which is what that code intended. No measured row changes.

## 7. Guard count

`ls tests/dispatch/T*.sh | wc -l` = **120** on main and `run-all.sh:25` declared
**120** — counted, not trusted, exactly because bb899 and sc899 had both bumped
116→118 independently. T122 and T123 were free numbers. `EXPECTED_GUARDS` **120 → 122**.

## 8. Snyk

`snyk_code_scan` over `src/` → **2 findings, both Low Path Traversal, both in
`src/hitl/cli.ts` (lines 213 and 382)** — the two the dispatch names as known and
not mine. **Zero findings in `src/comms-auditor/cli.ts`**, including the state-path
build, which D1's `/` refusal makes unreachable from input.

## 9. Rule 29 surface — exactly what changed

```
bin/session-comms-auditor.sh          226 → 88 lines (exec shim + the Rule 38 header)
src/comms-auditor/cli.ts              new  (NO usage.ts — see below)
tests/dispatch/T122_comms_auditor_parity.sh          new
tests/dispatch/T123_comms_auditor_workspace_shim.sh  new
tests/dispatch/run-all.sh             EXPECTED_GUARDS 120 → 122
.github/workflows/ci.yml              the guard-suite step's timeout-minutes 4 → 8
docs/reports/2026-08-17-899-t4-comms-auditor-{disposition,report}.md
```

**No manifest change**: `bin/init/manifest.mjs:47` already ships the shim and no bin
file was added. **No packaging change**: `package.json` `files` ships `dist/src`
wholesale, so `dist/src/comms-auditor/cli.js` ships with no per-CLI entry to add.

**NO usage.ts, and no `--help`** — unlike all seven sibling shims. Measured: the
bash read no argv whatsoever
(`grep -nE '\$[1-9]|\$@|\$\*|\$#|getopts|case "\$'` matched nothing), and `--help`
and `bogus --x` each ran a full audit pass. There was no `--help` surface to move,
and inventing one would be a contract change Rule 29 does not license. Every sibling
has a usage.ts because every sibling had a `usage()`; this one did not. T122 block J
pins the argv-is-ignored behaviour so a later port cannot grow one by accident.

## 10. The one extra, measured CI change

`.github/workflows/ci.yml` — the **Dispatch guard suite** step's
`timeout-minutes: 4` → `8`, that step only, nothing else in the file. The
measurement is sc899's: macos-latest for the SAME commit varied **2m44s vs 4m11s**
(87 s of spread) against a **3m07s** main baseline, so the 53 s of headroom sat
inside runner variance — and the cap fired on a suite that had already printed
`guards: 118 passed: 118 failed: 0`, costing one manual re-run. A timeout that trips
on a passing suite teaches people to re-run red CI, which is the opposite of what it
is for. 8 leaves ~5 min of headroom and still catches a real hang. Cited in the
commit message and in the file.

## 11. NOT checked / NOT done (Rule 38)

* **`bin/ask.sh` is untouched.** It holds the other half of D3's two-writer race and
  the other half of the fail-OPEN counter reset, and it builds the same state path
  from an unvalidated `--thread`. All three are the orchestrator's ticket, not this
  Rule 29 surface. **Consequence to be explicit about: a slashed `--thread` passed to
  `bin/ask.sh` still fails there** — this port fixed the auditor's arm of it only.
* **`bin/inject-handler.sh`, `bin/orchestrator-bridge-auditor.sh`,
  `src/reconciler/cli.ts` untouched.** The reconciler needs no edit: argv and env are
  unchanged. `bin/lib/workspace-host.sh` untouched (T3b declined).
* **The `/opt/homebrew/bin` PATH prefix was not removed**, only documented (§4).
* **No live daemon was contacted.** Every guard uses `lib.sh`'s temp state dir and
  its absolute-path `TELEPTY` recorder. :3848, `~/.telepty/config.json`, the
  `orchestrator` session and launchd were not touched. **Merge is a live deploy** —
  `src/reconciler/cli.ts:1292-1293` runs this every 60 s from launchd against the
  main checkout — and the shim fails loud (exit 2) if `dist/` is missing.
* **Not measured on Linux or on CI's macOS runner** — locally on darwin 25.4.0 only.
  CI is the check; there are no platform branches to diverge (§5).
* **The `peer_audit_record_skipped` telemetry reason is new** and no consumer reads
  it yet; nothing greps `state/session-comms/telemetry.jsonl` in-repo. It is a record
  for a human, deliberately, since the alternative was a silent skip.
* **Concurrency was measured only for D3's two-writer case.** Two auditor passes
  racing each other is not exercised — the reconciler ticks one at a time, and that
  assumption is now written down rather than tested.
* **`npm test` and the guard suite were run to completion; the packaging tests
  (`tests/packaging/*`) were not run locally** — CI runs them, and nothing in the
  ship set changed (§9).

## 12. Baseline / after (Rule 35)

| | before (31384e7) | after |
|---|---|---|
| `npx tsc -p .` | clean | clean |
| `npm test` | 225 pass / 0 fail | 225 pass / 0 fail |
| `bash tests/dispatch/run-all.sh` | guards 120, passed 120, failed 0, skipped 3 (T16 T48 T95) | guards 122, passed 122, failed 0, skipped 3 (T16 T48 T95) |
| Snyk `src/` | 2 Low PT in `src/hitl/cli.ts` | same 2, **0 new** |
