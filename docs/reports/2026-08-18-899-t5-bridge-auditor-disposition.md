# #899 tranche 5 — `bin/orchestrator-bridge-auditor.sh` → TypeScript: DISPOSITION

Track `ba899`. Base `origin/main` @ `c95fb34`, branch `feat/899-t5-ba899`,
worktree `~/.aigentry/worktrees/ba899`. **Phase 1 — nothing implemented yet.**
Every claim below was re-run against the ORIGINAL bash at `c95fb34`; the rig is
`measure.sh` (27 rows, hermetic: `ps` and `telepty` stubbed, state in a tmpdir,
`AUDITOR_NOW` pinned) and its raw transcript is quoted inline.

Target: 129 lines, `set -euo pipefail`, one `awk` program, one `python3 -c`, one
`ps`, one `telepty inject`. Warn-only duplicate-bridge detector (tq#620, the belt
for the #618 recurrence), wired into the reconcile tick at step 0d.

**The dispatch's own hard note is the first thing I measured, and it holds:** the
script invokes `kill` ZERO times. `grep -nE 'kill|SIGTERM|SIGKILL'` matches only
comment prose (:16, :18, :21-23) and the HOLD *message text* at :117
(`` `kill -9 <stale-pid>` `` — the remedy a human is told to run). Rig rows 03,
14, 16-20 all ran with a `kill` recorder stub on PATH; the recorder stayed empty
in every one. The port adds no kill path, and T127 asserts that two ways
(recorder stub + a static scan of the compiled JS).

---

## 0. Summary — what I want a GO on

| # | Item | My recommendation |
|---|---|---|
| **D1** | An unwritable `$DISPATCH_STATE_DIR` makes the duplicate-bridge HOLD **never send**, and turns the whole pass into `rc=1` → one folded `ERR bridge-auditor non-zero (continuing)` line. Measured (row 24). | **HOLD — I think this is a fix**, availability of a safety escalation at exactly the moment it matters. 3 lines. Falls back to reproduce-verbatim on your call. |
| **D2** | `--help` is `sed -n '30,40p' "$0"` — a slice of the script's OWN source. The shim has no such source, so the text must move to `usage.ts`. The 498 bytes it prints contain two pre-existing warts (starts mid-sentence; drops the `TELEPTY` seam line). | Reproduce **verbatim, warts included** (`src/bus-bridge/usage.ts` precedent). No GO needed unless you want the warts fixed. |
| **D3** | The bridge marker is a **substring match over the whole `command` column**, so any process whose command line merely *mentions* `telepty allow --id orchestrator ` is counted as a bridge — measured in the wild on this host. | Reproduce. **Name for a ticket**, out of scope. |
| **D4** | `python3` disappears entirely (the one `python3 -c` was a clock read). | Article 17 win, no decision needed. |

Everything else is byte-identical parity. **Guard count: 122 files on main
(`ls tests/dispatch/T*.sh | wc -l` = 122, `EXPECTED_GUARDS=122`) → 124 after my
two.** I take **T127** (parity) and **T128** (workspace-layout shim) as dispatched.

---

## 1. Subprocess children — `child | today | after T5 | why`

| child | today | after T5 | why |
|---|---|---|---|
| `"$SINGLETON_PS_CMD" -eo pid,etime,command` (:79) | subprocess, argv `-eo pid,etime,command` (row 01 `--ps argv--`) | **stays a subprocess, IDENTICAL argv** | node has no process lister. `SINGLETON_PS_CMD` is the T57 seam and must keep pointing at an arbitrary executable. |
| `"$TELEPTY" inject --submit "$ORCH_SID" "$msg"` (:124) | subprocess, 4 argv elements | **stays a subprocess, IDENTICAL argv** | measured NUL-split in row 03: `inject` / `--submit` / `orchestrator` / `<one text element>`. The HOLD text stays ONE argv element, so a pid list can never become a flag or a word split. |
| `python3 -c 'import datetime; …'` (:65) | subprocess (clock) | **GONE** — node's `Date` | the auditor's own clock, nothing transitive. There is no `.py` child here. This is the Article 17 win: python3 stops being a dependency of this script. |
| `date -u +%Y-%m-%dT%H:%M:%SZ` (:66) | fallback subprocess when python3 is absent | **GONE** | same clock. The fallback existed only because python3 might not be installed; node is by definition present. |
| `awk` (:80-99) | subprocess, the whole parse | **GONE** — node string logic | regex + `etime` → seconds + oldest-of is the auditor's own logic. |
| `sed -n '1p'` / `sed -n '2,$p'` (:101, :115) | 2 subprocesses re-slicing awk's own output | **GONE** | an intermediate that only existed because awk's stdout was a string. |
| `sed -n '30,40p' "$0"` (:58) | subprocess, self-slicing help | **GONE** → `src/bridge-auditor/usage.ts` | see D2. |
| `tee -a "$ALERTS_LOG"` (:71) | subprocess per alert | **GONE** — `fs.appendFileSync` + `process.stderr.write` | see D1 for the one behaviour that changes shape. |
| `mkdir -p` (:70), `printf` (:64, :71, :98, :101, :115) | subprocesses / builtins | **GONE** | `fs.mkdirSync({recursive:true})`. |

**Children after the port: exactly 2.** Both with identical argv.

## 2. Sourced-lib functions

**None. Zero.** `grep -nE '^[[:space:]]*(\.|source)[[:space:]]' bin/orchestrator-bridge-auditor.sh`
→ no match. Unlike tranches 2a/2c there is **no `bash -c '. lib; fn'` door and no
`bin/wh-cli.sh` verb to add**, and unlike the reconciler there is nothing from
`bin/lib/workspace-host.sh` in play (which the dispatch also forbids me to touch).

## 3. Guards — sourced vs invoked

| guard | how it reaches the script | needs `__probe`? |
|---|---|---|
| `T57_orchestrator_bridge_duplicate_warn.sh` | **INVOKED as a subprocess**: `AUDITOR="$REPO_ROOT/bin/orchestrator-bridge-auditor.sh"` (:31), `run() { … "$AUDITOR" "$@"; }` (:60) | no |
| `src/reconciler/cli.ts:1300-1301` (tick step 0d) | **INVOKED as a subprocess**: `runQuiet(BRIDGE_AUDITOR_SH, [], { ...env, TELEPTY })` behind `executable()` + `DRY_RUN === 0` | no |
| anything under `bin/` | **nothing invokes it at all.** `bin/session-reconciler.sh:38` names it in a *comment* only | — |

`grep -rnE '^\s*(\.|source)\s.*orchestrator-bridge-auditor' . ` matches **nothing**
anywhere in the repo. **So there is NO `__probe` surface** — same conclusion as
tranche 4, reached the same way. `__probe` would be dead code and Rule 29 does not
license inventing it.

**My two new guards, both invoked:** T127 parity (re-runnable against the original
bash via `$BRIDGE_AUDITOR_UNDER_TEST`, T122's mechanism) and T128 workspace layout
(T123's mechanism).

## 4. Env seams

| seam | default | read where | after the port |
|---|---|---|---|
| `ORCHESTRATOR_SID` | `orchestrator` | :45 | same. Row 14: `custom-orch` moves both the match marker AND the inject target sid. |
| `SINGLETON_PS_CMD` | `ps` | :46 | same. The T57/T127 process-lister seam. |
| `TELEPTY` | `telepty` | :47 | same. What the reconciler adds to the child env; what `lib.sh:45` sets absolutely so the hardened PATH cannot find a real `telepty`. |
| `DISPATCH_STATE_DIR` | `$REPO_DIR/state/dispatch` | :51 | same. `$REPO_DIR` = `$SCRIPT_DIR/..` — **load-bearing, see T128**. |
| `AUDITOR_NOW` | unset → real clock | :64 | same. Row 22 shows the real-clock arm producing `2026-08-17T15:38:03Z` (seconds precision, `Z`). |
| `PATH` hardening (:43) | `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH` | :43 | **STAYS IN BASH, byte-identical**, in the shim. It is what resolves the default literal `telepty` for the node process's child, and this script is reached from launchd every 60s where the inherited PATH is minimal. Same named tension as tranche 4 (`bin/session-cleanup.sh:34-41`, task #400's stale homebrew telepty): pre-existing, mentioned, not changed. |
| **`DRY_RUN`** | **NOT an env seam** | :54 is a plain `DRY_RUN=0` assignment | **the port MUST NOT read `env.DRY_RUN`.** Measured on the original: `DRY_RUN=1 … bin/orchestrator-bridge-auditor.sh` with 2 bridges **still sends the inject** (`INJECT: inject --submit orchestrator HOLD: …`). This is not academic — `src/reconciler/cli.ts:1154,1166` takes its own `DRY_RUN` from **argv only**, so `DRY_RUN=1 bin/session-reconciler.sh` (no `--dry-run`) leaves the reconciler acting *and* puts `DRY_RUN=1` in the `{ ...env, TELEPTY }` it hands step 0d. A port that read the env would silently downgrade the #618 HOLD to a dry-run log line on that host, forever. `src/reconciler/cli.ts:45` already documents that this script "sets its own". **T127 pins it.** |

## 5. Entrypoint contract — measured, with `pinned by`

`rc` / stdout / stderr / `alerts.log` / inject argv, all from `measure.sh` against
the original bash at `c95fb34`. "T57" = already pinned; "**T127**" = a line no guard
pins today and my parity guard will.

| # | input | rc | stdout | stderr + `alerts.log` | inject | pinned by |
|---|---|---|---|---|---|---|
| 1 | 0 bridges | 0 | empty | empty, **no file created** | none | T57 (C) |
| 2 | 1 bridge | 0 | empty | empty, no file | none | T57 (B) |
| 3 | 2 bridges | 0 | empty | `<iso> ORCH_BRIDGE_DUPLICATE count=2 pids=[50349(2-08:11:00), 74838(00:05:23)] likely_stale=50349 dry_run=0` (122 bytes, identical on both channels) | `inject` `--submit` `orchestrator` `HOLD: orchestrator-bridge DUPLICATE \| N=2 bridges (expected 1) \| pids: 50349(2-08:11:00), 74838(00:05:23) \| likely-stale=oldest=50349 \| remedy: confirm the live-TUI pid, then ``kill -9 <stale-pid>`` — USER-ONLY (automation must NOT kill). ref #618` | T57 (A) pins *substrings*; **T127** pins the alert line + the 4 argv elements verbatim |
| 4 | 2 bridges, `--dry-run` | 0 | empty | 2 lines: the row-3 line with `dry_run=1`, then `<iso> ORCH_BRIDGE_DUPLICATE would-HOLD (dry-run) → orchestrator` | none | T57 (F) pins "no inject"; **T127** pins both lines |
| 5 | 1 bridge, `--dry-run` | 0 | empty | empty, no file | none | **T127** |
| 6 | `-h` | 0 | **498 bytes, 11 lines** (§D2) | empty | none | **T127** |
| 7 | `--help` | 0 | same 498 bytes | empty | none | **T127** |
| 8 | `--bogus` | **4** | empty | `unknown: --bogus` (17 bytes) on **stderr only, no `alerts.log`** | none | **T127** |
| 9 | `--dry-run --dry-run` | 0 | empty | identical to row 4 (idempotent) | none | **T127** |
| 10 | `--dry-run bogus` | **4** | empty | `unknown: bogus` — **and NO alert at all**: argv is parsed to completion before `ps` is ever run | none | **T127** |
| 11 | `-h --dry-run` | 0 | the 498 bytes | empty | none | **T127** |
| 12 | `--dry-run -h` | 0 | the 498 bytes (`-h` wins wherever it appears) | empty | none | **T127** |
| 13 | `""` (one empty argv element) | **4** | empty | `unknown: ` (10 bytes — the trailing space is real) | none | **T127** |
| 14 | 2 `custom-orch` + 1 `orchestrator`, `ORCHESTRATOR_SID=custom-orch` | 0 | empty | `count=2 pids=[70001(01:00:00), 70002(00:10:00)] likely_stale=70001` | argv[2] = **`custom-orch`**; `50349` absent | T57 (G) |
| 15 | 1 `orchestrator` + 1 `orchestrator-2` | 0 | empty | empty | none — the trailing space in the marker holds | T57 (D) |
| 16 | 3 bridges | 0 | empty | `count=3 pids=[111(3-00:00:00), 222(00:00:10), 333(10:00)] likely_stale=111` | one inject, `N=3` | **T127** |
| 17 | 2 bridges, one `<defunct>` | 0 | empty | empty — zombie skipped, so `count=1` | none | **T127** |
| 18 | 2 bridges **+ the `PID ELAPSED COMMAND` header row** | 0 | empty | `count=2` — the header is dropped by `$1 ~ /[^0-9]/` | one inject | **T127** |
| 19 | 2 bridges, **identical etime** | 0 | empty | `likely_stale=111` — the FIRST of the tie wins (`ss[i] > maxs`, strict) | one inject | **T127** |
| 20 | etime `42` (bare seconds) vs `00:00:01` | 0 | empty | `likely_stale=111` — the 1-field `etime` arm parses as 42s | one inject | **T127** |
| 21 | `ps` prints nothing | 0 | empty | empty | none | **T127** |
| 22 | 2 bridges, `AUDITOR_NOW` unset | 0 | empty | timestamp is the real clock: `2026-08-17T15:38:03Z` — **seconds precision, `Z`, no milliseconds** | one inject | **T127** |
| 23 | `SINGLETON_PS_CMD` exits 3 and prints to stderr | **0** | empty | empty — `|| true` swallows it, `ps`'s own stderr is NOT captured | none | **T127** |
| 24 | 2 bridges, `$DISPATCH_STATE_DIR` **under a regular file** | **1** | empty | `tee: …/alerts.log: Not a directory` then the alert line | **NONE — the HOLD is suppressed** | **D1, T127** |
| 25 | 2 bridges, `TELEPTY` points at a nonexistent file | **0** | empty | the alert line, file written | inject attempted, `\|\| true` swallows the failure — **rc stays 0** | **T127** |
| 26 | 1 bridge, `DISPATCH_STATE_DIR` **unset** | 0 | — | nothing written (count ≤ 1 exits before any alert) | none | T128 covers the *default path* |
| 27 | 1 real bridge + 1 unrelated process whose **command line mentions the marker** | 0 | empty | `count=2 pids=[50349(00:05:23), 77777(00:01:00)] likely_stale=50349` | a **spurious** HOLD naming a non-bridge pid | **D3** |

Exit-code inventory: **0** (normal, no-dup, help, and every swallowed child
failure), **4** (unknown argument), **1** (undocumented — only D1), and after the
port **2** as well, from `bin/lib/node-shim.sh` when `dist/` does not resolve.

## 6. Platform branches

**Zero, and there was nothing to enumerate.**
`grep -nE 'uname|os_type|Darwin|Linux|pmset|ioreg|sw_vers|OSTYPE'` over the script
matches exactly one line — comment :29, which *asserts* the cross-OS property
rather than branching on it. `ps -eo pid,etime,command` is the same argv on
BSD/macOS and GNU/Linux (verified on this host: `PID ELAPSED COMMAND`, then
`1 81-03:24:43 /sbin/launchd`), and the `[[DD-]HH:]MM:SS` parser in `awk`
:81-88 exists precisely so no `ps` dialect needs a branch. Rule 26: the port gets
**zero `process.platform` branches.**

## 7. Latent defects — this is the HOLD

### D1 — an unwritable state dir suppresses the duplicate-bridge HOLD entirely **(availability of a safety escalation, at the one moment it matters)**

`emit_alert()` (:69-72) is

```bash
mkdir -p "$STATE_DIR" 2>/dev/null || true
printf '%s %s\n' "$(now_iso)" "$1" | tee -a "$ALERTS_LOG" >&2
```

`mkdir` is best-effort, but **`tee` is not**. Under `set -euo pipefail` a `tee`
that cannot open `$ALERTS_LOG` fails the pipeline and kills the script — at :119,
**five lines before the inject at :124**.

Reproduction (row 24: `DISPATCH_STATE_DIR` pointed under a regular file, 2 bridges):

```
rc=1
stderr: tee: …/blocker/state/alerts.log: Not a directory
        2026-08-18T00:00:00Z ORCH_BRIDGE_DUPLICATE count=2 pids=[…] likely_stale=50349 dry_run=0
inject: (NO INJECT — HOLD SUPPRESSED)
```

Why it matters in production and not just in a rig: `runQuiet` at
`src/reconciler/cli.ts:1301` discards both stdio streams, so the *only* surviving
signal is `log("ERR bridge-auditor non-zero (continuing)")` — one line, no reason,
identical to every other non-zero. The operator's #618 belt is silently gone while
the log says a tick ran. And the trigger is not exotic: a read-only or
wrong-permission `state/`, or anything that leaves a non-directory on the path.
Nothing about a *duplicate bridge* is what fails — the detector already succeeded.

Severity is the same shape as the two precedents you HOLD-approved fixes for
(`sc899` D1, `ca899` D1): one environmental accident permanently disables a
guardrail whose whole purpose is to survive an operator mistake.

**What I recommend (3 lines, and I want your GO before writing them):** the
alerts.log append becomes best-effort (`try { appendFileSync } catch {}`), the
stderr line is emitted unconditionally, and the pass continues to the inject.
Row 24 then becomes `rc=0` + the alert on stderr + **the HOLD delivered**.

**Falls back cleanly if you say reproduce:** I keep `rc=1` and no inject, and I
name one deviation — `tee`'s message (`tee: <path>: Not a directory`) is tee's own
and locale-dependent, so I would pin *the exit code and the fact of a stderr line*,
not the bytes. That is exactly T122's precedent for block J's `mkdir` message and
T116/T120's for locale-dependent text. **Say which.**

### D2 — `--help` prints a slice of the script's own source, and the slice is off by one

`-h|--help) sed -n '30,40p' "$0"; exit 0;;`. The 498 bytes it prints today:

```
# set of bin/orchestrator-boot.sh:48).
#
# Usage:
#   orchestrator-bridge-auditor.sh            # one audit pass (act: HOLD on duplicate)
#   orchestrator-bridge-auditor.sh --dry-run  # detect + log only, never inject
#
# Env:
#   ORCHESTRATOR_SID  orchestrator sid (default: orchestrator) — same source as
#                     bin/orchestrator-boot.sh:36 (Rule 16, no hardcode).
# Test seams (hermetic T57, mirror orchestrator-boot.sh:40-42):
#   SINGLETON_PS_CMD  process lister (default: ps)
```

Two pre-existing warts, both mechanical consequences of a hardcoded line range:
line 1 is a **dangling sentence fragment** (the tail of the :29-30 cross-OS
comment), and the range **ends at :40**, so line :41 — `TELEPTY   telepty binary
(default: telepty)` — is **cut off**: `--help` advertises one of the two test seams
and hides the other. The block it means to print is :32-41.

This is the one contract line that CANNOT survive mechanically: after the port the
shim is ~25 lines, so `sed -n '30,40p' "$0"` would print **nothing at all**. The
text moves to `src/bridge-auditor/usage.ts` **verbatim, warts included** — the
established call, `src/bus-bridge/usage.ts:11-15` keeps a lone leading `#` for
exactly this reason ("it is kept because it is what the CLI prints, not because it
is pretty"), and the same move is recorded for tranches 1, 1b, 2a, 2c, 2d and 3a.
No `-h` behaviour is pinned by any guard today; T127 rows 6/7/11/12 pin all 498
bytes. **Proceeding on the precedent unless you want the warts fixed — say so and
it becomes a 2-line usage.ts edit, not a code change.**

### D3 — the marker is a substring of the whole `command` column, so a *mention* counts as a bridge

`$0 ~ ("telepty allow --id " s " ")` tests the entire `ps` line. The snapshot-then-`awk`
split (:74-79) correctly prevents the auditor's own *pipeline* from self-matching,
but nothing stops **another** process whose command line merely contains the marker
from being counted, having its pid printed as a bridge, and — if it is the oldest —
being named `likely-stale=oldest=` in a HOLD that tells the operator to `kill -9` it.

Measured in the wild on this host, not just in the rig. `ps -eo pid,etime,command`
piped to a `grep` for the marker returned **3** matches; a clean snapshot taken
first and parsed with the auditor's own filter returned **1** (pid 6965, the real
2-day-old bridge). The two extra matches were the measuring shell itself —
`/bin/zsh -c '… awk '\''$0 ~ ("telepty allow --id orchestrator ")…'` — i.e. real
processes, alive at audit time, whose only sin was naming the marker in their argv.
Row 27 is the same shape as a fixture.

Consequences, in order of how much they bother me: an operator who greps for the
marker while a tick fires gets a **spurious duplicate HOLD**; and the HOLD's
`likely-stale=oldest=` can name a pid that is not a bridge at all. It never kills
(D0 above), and the text already hedges with *likely* and "confirm the live-TUI pid
first", which is why I am not proposing to touch it. But the false-positive class
is real and it is inherent to a `ps`-substring detector: tightening it means
requiring the match to *begin* at a telepty executable path, which changes what
counts as a bridge — a detection-policy call with its own blast radius on #618, not
a port. **REPRODUCED as-is; naming it for a ticket** (`bin/orchestrator-boot.sh:88`
and `bin/session-reconciler.sh:415` share the marker, so any tightening is a
three-site change, which is exactly why it is not mine).

### D4 — not a defect: python3 leaves, and I checked that nothing follows it out

The single `python3 -c` (:65) is a clock read whose only output is
`datetime.now(utc).isoformat(timespec="seconds").replace("+00:00","Z")`, with a
`date -u +%Y-%m-%dT%H:%M:%SZ` fallback. `new Date().toISOString()` sliced to
seconds + `Z` is the same string (row 22 measured `2026-08-17T15:38:03Z` from the
python arm — seconds precision, no milliseconds, `Z` suffix). So **python3 stops
being a dependency of this script**, no `.py` child is left behind, and the
`AUDITOR_NOW` override keeps precedence. Header comment :28 ("pure bash + telepty…
no python") was already wrong about this; the port makes it true.

### Not a separate defect, no change proposed

`emit_alert` runs `mkdir -p "$STATE_DIR"` on **every** call rather than once — two
syscalls per duplicate under `--dry-run`. Reproduced (as `mkdirSync({recursive:true})`
per alert). Naming it only so "the port does one mkdir" cannot be mistaken for a
measurement I missed.

## 8. Deliverable file list (Rule 29 surface)

| file | change |
|---|---|
| `bin/orchestrator-bridge-auditor.sh` | 129-line script → ~25-line exec shim over `bin/lib/node-shim.sh` (reused, unmodified), with the PATH hardening and the Rule 38 contract notes in its header |
| `src/bridge-auditor/cli.ts` | **new** — the implementation |
| `src/bridge-auditor/usage.ts` | **new** — the 498 `--help` bytes, verbatim (D2) |
| `tests/dispatch/T127_bridge_auditor_parity.sh` | **new** |
| `tests/dispatch/T128_bridge_auditor_workspace_shim.sh` | **new** |
| `tests/dispatch/run-all.sh` | `EXPECTED_GUARDS` 122 → 124, and the two names in the manifest list |
| `docs/reports/2026-08-18-899-t5-bridge-auditor-{disposition,report}.md` | this file + the REPORT |

**NOT touched:** `bin/init/manifest.mjs` — it already lists
`bin/orchestrator-bridge-auditor.sh` at :43 and no bin file is being added.
`bin/lib/workspace-host.sh` (dispatch forbids it). `src/reconciler/cli.ts` — step
0d's call site needs no change; it invokes a path with no argv and the shim keeps
the same path, argv and exit codes. `bin/lib/node-shim.sh` — reused as-is.
`tests/dispatch/T57_*` — kept exactly as it is; T127 is additive.

## 9. HARD constraints acknowledged

Production daemon `:3848`, `~/.telepty/config.json`, the live `orchestrator`
session and launchd are UNTOUCHABLE — every rig row and both new guards stub `ps`
and `telepty` and write state into a tmpdir, so nothing reaches the real daemon and
no real process is ever listed for effect or signalled. The one live-host command I
ran was a **read-only** `ps` snapshot into a scratch file (D3). Merge is a live
deploy, so the shim fails loud (`exit 2` with the node-shim diagnostic). Worktree
only, branch + PR, CI 4/4, **NO merge**. `ih899` is porting a different script; my
files are disjoint — if I land second I rebase and take the next free guard numbers
and say which.

## 10. Baseline BEFORE (Rule 35)

* `npm test` → **225/225 pass, exit 0** (`# pass 225 # fail 0`).
* `bash tests/dispatch/run-all.sh` → running; the count to match is 122/122 with
  `T16 T48 T95` skipped. Recorded in the REPORT with the after-figure.
* `npx tsc -p .` → clean on the fresh worktree before any edit.
* Snyk: `snyk_code_scan` after implementation, target 0 new (the 2 pre-existing Low
  path-traversal findings in `src/hitl/cli.ts` are known).

---

**Waiting on GO.** The only question that changes code is **D1 — fix or
reproduce.** D2 proceeds on the bus-bridge precedent (verbatim, warts included)
and D3 is reproduced-and-ticketed unless you say otherwise.
