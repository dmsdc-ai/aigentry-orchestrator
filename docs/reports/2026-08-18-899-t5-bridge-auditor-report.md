# #899 tranche 5 — `bin/orchestrator-bridge-auditor.sh` → TypeScript: REPORT

Track `ba899`. Branch `feat/899-t5-ba899` off `origin/main` @ `c95fb34`,
worktree `~/.aigentry/worktrees/ba899`. Disposition (Phase 1, GO'd):
`docs/reports/2026-08-18-899-t5-bridge-auditor-disposition.md`.

Commits: `c437b65` disposition · `79632c7` the port + T127/T128 · this report.

The GO was: **D1 = fix** (best-effort alerts.log append, the HOLD must be sent even
if the log write fails, RED-first with an unwritable `DISPATCH_STATE_DIR`),
**D2 = verbatim usage.ts**, **D3 = reproduce + name for a ticket, with the exact
in-the-wild false positive in this report**, and **keep zero kill paths, asserted in
T127**. All four are done; §6 D4 is one deviation I found while implementing and did
not have a GO for — it is named, pinned from both sides, and reversible in one line.

129 lines of bash → a 108-line shim (89 of them the Rule 38 header) + 294 lines of
TypeScript + 37 lines of usage. Two guards, 703 lines.

---

## 1. Guard split — sourced vs invoked

| consumer | how it reaches the script | `__probe` |
|---|---|---|
| `tests/dispatch/T57` | **invoked**, `"$AUDITOR" "$@"` (:60) | no |
| `src/reconciler/cli.ts:1300-1301` (tick step 0d) | **invoked**, `runQuiet(BRIDGE_AUDITOR_SH, [], { ...env, TELEPTY })` behind `executable()` + `DRY_RUN === 0` | no |
| anything under `bin/` | **nothing invokes it**; `bin/session-reconciler.sh:38` is a comment | — |
| `tests/dispatch/T127` (new) | **invoked**, via `$BRIDGE_AUDITOR_UNDER_TEST` | no |
| `tests/dispatch/T128` (new) | **invoked**, from a workspace copy of `bin/` | no |

`grep -rnE '^\s*(\.|source)\s.*orchestrator-bridge-auditor'` over the repo matches
**nothing**, and the script itself sourced **zero** libs
(`grep -nE '^[[:space:]]*(\.|source)[[:space:]]'` → no match). **So there is no
`__probe` surface, no `bash -c '. lib; fn'` door and no `bin/wh-cli.sh` verb.**
`bin/lib/workspace-host.sh` is untouched, as dispatched.

T57 is unchanged and still passes against the port.

## 2. Doors

Two children survive. Both keep IDENTICAL argv:

| child | argv | why it stays |
|---|---|---|
| process lister | `"$SINGLETON_PS_CMD" -eo pid,etime,command` | node has no process lister; `SINGLETON_PS_CMD` is the T57/T127 seam and must accept any executable. T127 block A asserts the argv string itself. |
| transport | `"$TELEPTY" inject --submit "$ORCH_SID" "<one text element>"` | T127 block A asserts it **as argv** — 4 elements, the HOLD text being exactly one — so a pid list can never become a flag or a word split. |

Gone (node-internal now): `awk`, two `sed`, `tee`, `mkdir`, `printf`, the
`python3 -c` clock read and its `date -u` fallback. **python3 stops being a
dependency of this script** — no `.py` child remains, so the header's "pure bash +
telepty, no python" claim is finally true (Article 17).

## 3. Contract table — `pinned by`, before and after

All 27 disposition rows re-verified against the port. Rows unchanged unless marked.

| # | input | before | after | pinned by |
|---|---|---|---|---|
| 1-2 | 0 / 1 bridge | rc 0, silent, no file | same | T57 B/C, T127 B2 |
| 3 | 2 bridges | rc 0; the alert line on stderr **and** alerts.log; 4-element inject | same, byte for byte | **T127 A** |
| 4 | `--dry-run` | rc 0; two alert lines; no inject | same | T57 F, **T127 B** |
| 5 | 1 bridge `--dry-run` | rc 0, silent | same | **T127 B2** |
| 6-7, 11-12 | `-h` / `--help` / `-h --dry-run` / `--dry-run -h` | rc 0, **498 bytes** | same 498 bytes, now from `usage.ts` | **T127 C**, T128 C |
| 8, 10, 13 | `--bogus` / `--dry-run bogus` / `""` | rc **4**, `unknown: <arg>`, no alert | same, incl. the trailing space of `unknown: ` | **T127 D1/D2/D3** |
| 9 | `--dry-run --dry-run` | idempotent | same | **T127 B** |
| 14 | `ORCHESTRATOR_SID=custom-orch` | moves the marker AND the inject target | same | T57 G |
| 15 | `orchestrator` + `orchestrator-2 ` | counts 1 (trailing space) | same | T57 D |
| 16 | 3 bridges | `count=3`, `N=3` | same | **T127 E1** |
| 17 | `<defunct>` | skipped | same | **T127 E2** |
| 18 | `PID ELAPSED COMMAND` header | dropped | same | **T127 E3** |
| 19 | etime tie | flags the FIRST | same | **T127 F1** |
| 20 | etime `42` | parses as 42s | same | **T127 F2** |
| — | etime `1-00:00:01` vs `00:05:23` | day part wins | same | **T127 F3** |
| 21, 23 | `ps` empty / exits 3 with stderr | rc 0, silent, stderr NOT forwarded | same | **T127 L1/L2** |
| 22 | `AUDITOR_NOW` unset | real clock, seconds precision + `Z` | same (`toISOString().slice(0,19)+"Z"`) | — |
| **24** | **unwritable `$DISPATCH_STATE_DIR`, 2 bridges** | **rc 1, NO inject** | **rc 0, alert on stderr, HOLD DELIVERED** | **T127 J, both sides** |
| 25 | `TELEPTY` missing, 2 bridges | rc 0, alert written, failure swallowed | same | **T127 L3** |
| 26 | `DISPATCH_STATE_DIR` unset | default `$SCRIPT_DIR/../state/dispatch` | same, via `AIGENTRY_SHIM_SCRIPT_DIR` | **T128 A/B** |
| 27 | a process that MENTIONS the marker | counted as a bridge | same (D3) | **T127 H** |
| — | env `DRY_RUN=1`, no argv | **IGNORED**, inject still sent | same | **T127 G** |
| — | `ORCHESTRATOR_SID=orch.tor` | regex: counts 3 | **literal: counts 1** (D4) | **T127 I1, both sides** |
| — | `ORCHESTRATOR_SID='orch['` | **rc 2**, `awk: nonterminated character class` | rc 0, just a sid (D4) | **T127 I2, both sides** |
| — | neither dist layout resolves | (n/a) | rc **2** + node-shim diagnostic | **T128 D** |

Exit codes: **0** normal/help/every swallowed child failure, **4** unknown argument,
**2** dist unresolvable (new, `bin/lib/node-shim.sh`). The bash's undocumented **1**
is gone — that was D1.

### Parity is re-runnable, and non-vacuous in both directions

```bash
# the ORIGINAL bash, with the parity flag → PASS
git show c95fb34:bin/orchestrator-bridge-auditor.sh > bin/.bridge-auditor-original.sh
chmod +x bin/.bridge-auditor-original.sh
BRIDGE_AUDITOR_UNDER_TEST="$PWD/bin/.bridge-auditor-original.sh" \
  BRIDGE_PARITY_ORIGINAL=1 bash tests/dispatch/T127_bridge_auditor_parity.sh
#   → T127 PASS blocks=A-L original=1 help_bytes=498 children=ps+telepty kill_paths=0

# the ORIGINAL bash, WITHOUT the flag → FAIL, at the first behaviour that changed
BRIDGE_AUDITOR_UNDER_TEST="$PWD/bin/.bridge-auditor-original.sh" \
  bash tests/dispatch/T127_bridge_auditor_parity.sh
#   → FAIL[T127]: I1[port]: 'orch.tor' must match ONLY the literal sid … count=3

# the PORT, no flag → PASS
bash tests/dispatch/T127_bridge_auditor_parity.sh
#   → T127 PASS blocks=A-L original=0 help_bytes=498 children=ps+telepty kill_paths=0
```

Blocks A–H, K1 and L are **green against both implementations** — that is the parity
claim, measured, not reviewed. Blocks I and J assert *contradictory* outcomes on
identical input (rc 1 + no inject vs rc 0 + inject; `count=3` vs silence), so a pass
in one direction is a proof of failure in the other; neither is skipped.

## 4. Env seams

`ORCHESTRATOR_SID`, `SINGLETON_PS_CMD`, `TELEPTY`, `DISPATCH_STATE_DIR`,
`AUDITOR_NOW` — all unchanged, same defaults. The `PATH` hardening stays **in bash,
byte-identical**, in the shim (it is what resolves the literal `telepty` for the node
process's child, and launchd's inherited PATH is minimal). Its pre-existing tension
with task #400's stale-homebrew-telepty lesson (`bin/session-cleanup.sh:34-41`) is
named in the shim header, mentioned not changed (Rule 29).

**One seam that is NOT a seam, and the hazard this port could have introduced.**
`DRY_RUN` is argv-only: bash :54 was a plain `DRY_RUN=0` assignment, and
`src/reconciler/cli.ts:45` explicitly relies on that. The reconciler takes its own
`DRY_RUN` from **argv alone** (`cli.ts:1154,1166`), so `DRY_RUN=1
bin/session-reconciler.sh` with no `--dry-run` leaves the reconciler *acting* and
puts `DRY_RUN=1` into the `{ ...env, TELEPTY }` it hands step 0d. A port that read
`env.DRY_RUN` would have downgraded every #618 HOLD on such a host to a log line,
forever, with nothing in any log to say so. Measured on the original (inject still
sent); **T127 block G** pins it.

## 5. Platform branches

**Zero, and nothing to enumerate.** `grep -nE
'uname|os_type|Darwin|Linux|pmset|ioreg|sw_vers|OSTYPE'` over the bash matched one
line — comment :29, asserting the cross-OS property rather than branching on it.
`ps -eo pid,etime,command` is the same argv on BSD/macOS and GNU/Linux (verified on
the port host: `PID ELAPSED COMMAND`, `1 81-03:24:43 /sbin/launchd`), and the
`[[DD-]HH:]MM:SS` parser exists precisely so no `ps` dialect needs a branch. Rule 26
satisfied with no `process.platform` in the file.

## 6. Defects — one fixed, two reproduced, one deviation named

### D1 — FIXED on the orchestrator's GO

`emit_alert` was `printf … | tee -a "$ALERTS_LOG" >&2`. The `mkdir -p` was
best-effort (`2>/dev/null || true`); the **`tee` was not**, so under `set -euo
pipefail` a tee that could not open alerts.log failed the pipeline and killed the
script at bash :119 — **five lines before the inject at :124**. Measured with
`DISPATCH_STATE_DIR` under a regular file, two bridges present:

```
rc=1
stderr: tee: …/blocker/state/alerts.log: Not a directory
        2026-08-18T00:00:00Z ORCH_BRIDGE_DUPLICATE count=2 pids=[…] likely_stale=50349 dry_run=0
inject: (NO INJECT — HOLD SUPPRESSED)
```

The detector had already succeeded; only the alarm was lost. And it was lost
silently: `runQuiet` (`src/reconciler/cli.ts:1301`) discards both stdio streams, so
the sole surviving signal was one `ERR bridge-auditor non-zero (continuing)` line,
indistinguishable from any other non-zero — the #618 belt gone while the tick logged
a clean pass. The trigger needs no duplicate-bridge weirdness at all: a read-only
`state/`, wrong permissions, or a non-directory on the path.

Now the append is best-effort like its mkdir already was, the stderr copy is emitted
either way, and **the pass continues to the inject**. After: `rc=0`, the alert on
stderr, the HOLD delivered with its text intact. Every other row byte-unchanged.

**RED-first, as instructed.** T127 was written and run against the still-unported
bash before `src/bridge-auditor/` existed. Block J's port arm failed exactly as it
should have:

```
FAIL[T127]: J[port]: THE DUPLICATE-BRIDGE HOLD WAS SUPPRESSED by an unwritable
state dir. This is D1: the detector succeeded and the alarm was lost, and
src/reconciler/cli.ts:1301 discards the stderr that would have said so.
```

It went green only after the fix landed, and `BRIDGE_PARITY_ORIGINAL=1` still
asserts the original's `rc 1` + no inject. `tee`'s own message bytes are
**deliberately not pinned** — locale-dependent, T122 block J / T116 / T120
precedent; the exit code and the fact of a stderr line are the contract.

### D2 — REPRODUCED VERBATIM in `src/bridge-auditor/usage.ts`

`--help` was `sed -n '30,40p' "$0"` — a slice of the script's own comment header.
After the port there is no such header, so `sed` would have printed **nothing** and
`--help` would have silently become empty. The 498 bytes moved unchanged, warts
included: it opens on a **dangling sentence fragment**
(`# set of bin/orchestrator-boot.sh:48).`) and the range **ends at :40**, so :41's
`TELEPTY  telepty binary (default: telepty)` is cut off — `--help` has always
advertised one of the two test seams and hidden the other. Kept on the
`src/bus-bridge/usage.ts:11-15` precedent ("it is what the CLI prints, not because
it is pretty"). T127 block C pins all 498 bytes in all four flag positions and
asserts the fixture is itself 498 bytes; T128 block C re-checks it through the
workspace layout, where the text is served from the package's `dist/` while the shim
is the workspace's own file.

The shim's own `Usage:`/`Env:` header block is documentation for a reader of the
file and is **not** what `--help` prints — stated in the shim so the two cannot be
confused later.

### D3 — REPRODUCED, and here is the exact false positive from the wild

The marker is tested against the whole `command` column, so a process that merely
**mentions** `telepty allow --id <sid> ` is counted as a bridge. This is what the
port host actually returned. `ps -eo pid,etime,command` piped into a grep for the
marker gave **3** hits; a clean snapshot parsed with the auditor's own filter gave
**1**. The three lines, abridged only where noted:

```
66756       00:00 /bin/zsh -c source /Users/duckyoungkim/.claude/shell-snapshots/snapshot-zsh-1786980220797-cckbmv.sh 2>/dev/null || true && export CODEX_COMPANION_SESSION_ID='2721489b-…' … && eval 'SNAP="$(ps -eo pid,etime,command 2>/dev/null || true)"; printf … | awk '"'"'$0 ~ ("telepty allow --id orchestrator ") { print }'"'"' | head -10; …'
66758       00:00 /bin/zsh -c  … the SAME text again (the second stage of the same pipeline)
 6965 02-00:05:21 node /Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/telepty allow --id orchestrator claude --dangerously-skip-permissions --continue
```

* **6965** is the one real bridge — 2 days old, the live one.
* **66756 and 66758** are two `/bin/zsh -c` wrapper processes running *my own
  measurement pipeline*. Their only sin is that the awk program text
  `("telepty allow --id orchestrator ")` appears in their argv. They are real,
  alive, and matched.

**The bite is sharper than noise.** Had a reconcile tick fired in that window, the
auditor would have reported `N=3`, named `66756`/`66758` as bridges, and — because
`likely-stale=oldest=` picks the greatest `etime` — flagged **6965, the LIVE
bridge**, as the likely-stale one, in a HOLD whose remedy is `kill -9 <stale-pid>`.
The false positives are seconds old; the genuine bridge is days old, so a spurious
match *inverts* the oldest-is-stale heuristic. This is exactly what the message's
hedging is load-bearing for ("flags the oldest pid as *likely* stale and tells the
operator to confirm the live-TUI pid first", bash :22-24) and why #606's warn-only
rule matters more than it looks.

Reproduced, not fixed: tightening it means requiring the match to *begin* at a
telepty executable path, which changes what counts as a bridge across the **three
sites that share this marker** — `bin/orchestrator-boot.sh:88`,
`bin/session-reconciler.sh:415` and here. That is a detection-policy call with its
own blast radius on #618, not a port's. **Named for a ticket.** T127 block H pins
the false positive so it cannot be lost, and its failure message says out loud that
a change here may be an improvement but needs its own ticket.

The snapshot-then-parse split (bash :74-79) is kept — it is what stops this process
from matching *itself*, and it does nothing about anyone else.

### D4 — DEVIATION, found while implementing, no GO for it: `ORCHESTRATOR_SID` is now LITERAL

The bash matched the sid **as a dynamic regex**: `awk -v s="$ORCH_SID"` then
`$0 ~ ("telepty allow --id " s " ")`. Two layers of interpretation, both measured on
the original against three bridges with sids `orchXtor` / `orchYtor` / `orch.tor`:

| sid | original bash | port |
|---|---|---|
| `orch.tor` | `count=3`, a HOLD naming all three pids, `likely_stale=333` | `count=1` → silence |
| `orch[` | **rc 2**, `awk: nonterminated character class`, pass dead | rc 0, just a sid |
| `orch\ttor` | `-v` expanded the escape to a TAB, marker matched nothing, silent 0 | treated as the literal 9 characters |

I chose the literal. A single `.` — plausible in any hostname-shaped sid —
over-matched every sibling sid in the bash, and an invalid-regex sid killed the whole
pass with an exit code that now means "dist not found". The deviation only ever
matches **narrower**, and a real bridge's command line contains its sid literally
(telepty is invoked with it), so **no genuine duplicate can be missed and no new
false positive is possible**; the rc-2 crash arm disappears. Reproducing awk's
ERE-from-config in node would import both the over-match and the crash for
byte-identity on a config value no operator sets that way.

Named rather than silent (Rule 38), in the shim header and `cli.ts`, and pinned from
both sides by T127 block I. **It is one line to reverse** (`MARKER` becomes a
`RegExp`) if you want the regex semantics back.

### Reproduced without comment elsewhere

`emit_alert` still runs its `mkdir` on **every** call rather than once (two under
`--dry-run`); the etime tie still resolves to the FIRST; `<defunct>` still skipped;
the `ps` header row still dropped by the numeric-pid filter; every child failure
still swallowed to exit 0, a missing `telepty` included. All measured, all
reproduced, all pinned.

## 7. Zero kill paths, asserted twice

`kill` appears in `src/bridge-auditor/cli.ts` in exactly one place: inside the HOLD
string a **human** reads. T127 block K asserts the invariant two ways, because they
catch different things:

* **K1 — the recorder.** A `kill` stub on PATH must stay empty. Every
  duplicate-detecting block in T127 runs with it and asserts after; K1 does one
  explicit end-to-end pass (act *and* `--dry-run`), and first checks that a HOLD
  *was* sent so the assertion cannot be vacuous. T57 block E is the original version
  and still passes.
* **K2 — the static scan.** A recorder only catches a `kill` that *runs*; K2 catches
  one that *exists*, including on a branch no fixture reaches. It strips comment-only
  lines and the `kill -9` HOLD string from the **compiled** `dist/…/cli.js`, then
  refuses `process.kill`, `.kill(`, `SIGKILL`, `SIGTERM`, `SIGHUP` and a `"kill"`
  argv literal.

**K2 was verified non-vacuous**, by appending each of these to the compiled output
in turn and confirming T127 goes red, then restoring `dist/` byte-identically
(`diff -q` clean):

```
process.kill(Number(oldest.pid), "SIGKILL");            → FAIL[T127]: K2
spawnSync("kill", ["-9", oldest.pid]);                  → FAIL[T127]: K2
child.kill();                                           → FAIL[T127]: K2
spawnSync(TELEPTY, ["inject"], {}); tree.kill("SIGTERM") → FAIL[T127]: K2
```

The port adds no kill path and, per the dispatch note, **the reconcile tick's step 0d
call remains DETECT+WARN only** — unchanged call site, unchanged argv, unchanged
exit-code meaning.

T128 also asserts an empty kill recorder in its workspace and repo arms.

## 8. T128 verified non-vacuous

The quiet failure T128 exists for is a root derived from the compiled module's
location instead of `AIGENTRY_SHIM_SCRIPT_DIR`: the pass still exits 0 and still
injects, but a workspace alerts into the installed **package** while its own
`state/dispatch/alerts.log` stays empty forever. Simulated by patching
`env.AIGENTRY_SHIM_SCRIPT_DIR ||` to `undefined ||` in the compiled output:

```
FAIL[T128]: the pass wrote no alerts.log under the WORKSPACE's state/ —
AIGENTRY_SHIM_SCRIPT_DIR was not honoured, so the default DISPATCH_STATE_DIR
pointed somewhere else.
```

Restored, green, `dist/` byte-identical.

**One harness trap worth recording for the next port:** `tests/dispatch/lib.sh:34`
**exports** `DISPATCH_STATE_DIR`, so a workspace-default arm inherits it and the
assertion becomes vacuous. T128's A/B/C arms run under `env -u DISPATCH_STATE_DIR`
for that reason. T123 did not need this because `SESSION_COMMS_DIR` is not one of
the harness exports.

## 9. Guard count

**122 → 124.** `ls tests/dispatch/T*.sh | wc -l` = 124, `EXPECTED_GUARDS=124`
(`tests/dispatch/run-all.sh:25`). Both counted from the files, not from prose — 122
was confirmed on `origin/main` before starting, exactly as the dispatch warned. I
took **T127** (parity) and **T128** (workspace shim) as assigned; `ih899` is porting
a different script and my files are disjoint.

## 10. Snyk

`snyk_code_scan` over the worktree: **12 findings, all Low, all pre-existing, ZERO
in `src/bridge-auditor/`.**

| file | count | note |
|---|---|---|
| `bin/dispatch-registry.py` | 5 | pre-existing |
| `bin/spawn-telemetry-report.mjs` | 3 | pre-existing |
| `src/hitl/cli.ts` | 2 | the known pair named in the dispatch |
| `tests/gate/class-b-validator.test.ts`, `tests/session/warn-mode-telemetry.test.ts` | 2 | pre-existing, test files |

**0 new.** Nothing in the report references `src/bridge-auditor/cli.ts`,
`src/bridge-auditor/usage.ts` or the two new guards.

## 11. Rule 29 surface — exactly what changed

| file | lines | change |
|---|---|---|
| `bin/orchestrator-bridge-auditor.sh` | 129 → 108 | exec shim over `bin/lib/node-shim.sh`; PATH hardening kept byte-identical; 89 lines of Rule 38 header |
| `src/bridge-auditor/cli.ts` | +294 | new |
| `src/bridge-auditor/usage.ts` | +37 | new — the 498 `--help` bytes |
| `tests/dispatch/T127_bridge_auditor_parity.sh` | +507 | new |
| `tests/dispatch/T128_bridge_auditor_workspace_shim.sh` | +196 | new |
| `tests/dispatch/run-all.sh` | 1 line | `EXPECTED_GUARDS` 122 → 124 |

**NOT touched:** `bin/init/manifest.mjs` (already lists the script at :43; no bin
file added), `bin/lib/node-shim.sh` (reused unmodified), `bin/lib/workspace-host.sh`
(forbidden), `src/reconciler/cli.ts` (step 0d needs no change — same path, same
argv, same exit codes), `tests/dispatch/T57` (kept as-is; T127 is additive),
`bin/orchestrator-boot.sh` and `bin/session-reconciler.sh` (they share D3's marker;
not this task's surface).

## 12. NOT checked / NOT done (Rule 38)

* **`tee`'s stderr bytes in D1's original arm** are not pinned — locale-dependent.
  The exit code and the fact of a stderr line are.
* **T128 block D (fail-loud) is precondition-gated.** The shim prepends
  `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`, so on a host with
  `@dmsdc-ai/aigentry-orchestrator` globally installed in one of those four the
  "neither layout resolves" state cannot be constructed. The guard prints a
  `T128 note:` line naming what was not exercised. It deliberately avoids the word
  SKIP: `run-all.sh:43-44` enforces an exact skip **set** and T128 is not in it. On
  this host and on a clean CI runner (no global install measured:
  `command -v aigentry-orchestrator` → nothing) block D **does** run.
* **The real daemon was never contacted.** `:3848`, `~/.telepty/config.json`, the
  live `orchestrator` session and launchd are untouched. Every rig row and both
  guards stub `ps` and `telepty` and write into a tmpdir. The only live-host command
  was a **read-only** `ps` snapshot into a scratch file (D3's measurement). Nothing
  was ever signalled: the port has no kill path and no test invokes one.
* **The auditor was never run against the real process table for effect** — D3's
  snapshot was parsed offline in a scratch file, not by the auditor.
* **D3 is not fixed** and **D4's regex semantics are not reproduced** — both named
  above with their measurements.
* **`bin/ask.sh`'s and `session-comms-auditor.sh`'s `ORCHESTRATOR_SID*` name spread**
  (three different env names across eight sites, `docs/specs/2026-08-15-npm-init-environment.md:253`)
  is pre-existing and out of scope; mentioned, not touched.
* **No live `--dry-run` audit against the production tick** was run; step 0d's
  wiring is asserted by reading the call site, not by ticking the real reconciler.
* **Windows** is not considered anywhere; the repo targets macOS + Linux.

## 13. Baseline / after (Rule 35)

| check | before (`c95fb34`) | after |
|---|---|---|
| `npx tsc -p .` | clean | clean |
| `npm test` | **225/225 pass, 0 fail** | **225/225 pass, 0 fail** |
| `bash tests/dispatch/run-all.sh` | **guards 122, passed 122, failed 0, skipped 3 (T16 T48 T95)** | **guards 124, passed 124, failed 0, skipped 3 (T16 T48 T95)** — same skip set, +T127/T128 |
| `snyk_code_scan` | 12 Low | 12 Low, **0 new** |
| T57 | PASS | PASS (unchanged file) |
| T127 / T128 | — | PASS (+ both proven non-vacuous, §3/§7/§8) |
