# HOLD — ts899 (#899 tranche 1): the exec-shim shape and the 30-guard black-box spec are in direct conflict

Status: **HOLD on scope boundary**. Baselines measured, contract enumerated, port NOT yet started
on the disputed surface. Work that is identical under both readings continues while this HOLD is open.

---

## 1. Baselines (re-measured, worktree `~/.aigentry/worktrees/ts899`, branch `feat/899-t1-dispatch-ts` off `origin/main` a9e2385)

| Suite | Ref claimed | Measured | Delta |
|---|---|---|---|
| `npm test` | 225+ | `tests 225 / pass 225 / fail 0` | **matches** |
| `bash tests/dispatch/run-all.sh` | `guards: 97 passed: 97 failed: 0 skipped: 3` | `guards: 97  passed: 97  failed: 0  skipped: 3 (3 announcement(s))`, skip set `T16 T48 T95` | **matches** |

One trap worth recording for the next tranche: a **fresh worktree measures 93/97 with skip set
`T16 T47 T48 T95`** until `npx tsc -p .` has been run. T17/T18/T24/T83 fail and T47 skips purely on
`dist/src/session/inject-parser.js` being absent. The skip-set assertion fires as
`SKIP-SET MISMATCH on darwin` and reads like a real regression. Build first; that is not a code defect.
(`EXPECTED_GUARDS=97`, `tests/dispatch/run-all.sh:19`.)

## 2. The conflict

The ref specifies two things that cannot both hold:

- **Shape**: "a thin `bin/dispatch.sh` that becomes a 3-line exec shim onto `node dist/src/dispatch/cli.js "$@"`"
- **Spec**: "**Those 30 guards are the black-box spec** … must be green with the SAME skip set before and after"

Measured: **12 of the 30 guards do not treat `dispatch.sh` as a black box at all.** They `source` it as a
**bash library** under `DISPATCH_SH_NO_MAIN=1` (dispatch.sh:600 `return 0 2>/dev/null || exit 0`), assign
its shell variables directly, override `sleep` in scope, and call its internal functions:

| Sourced function | Guards (8+3+1 = 12) |
|---|---|
| `is_ready <sid> <cli>` | T4 T5 T11 T12 T13 T14 T15 T50 |
| `verify_delivered <sid>` | T6 T7 T91 |
| `prepare_effective_ref`, `do_inject` | T67 |

Example (T11:9-12):
```
export DISPATCH_SH_NO_MAIN=1
source "$REPO_ROOT/bin/dispatch.sh"
if is_ready sid-A claude; then echo "T11 PASS"; ...
```
T6:14-17 additionally sets `ref_file="$ref"` and defines `sleep() { :; }; export -f sleep` to skip the 5s
wait inside `verify_delivered`. T67:83 sets `ref_file` and `from_id` before calling `prepare_effective_ref`.

A 3-line `exec node …` shim exports no shell functions and holds no shell variables. **All 12 break.**
The `DISPATCH_SH_NO_MAIN=1` sourceable-library mode is itself part of the measured contract
(dispatch.sh:62, :181, :600) and the ref's flag list did not cover it.

## 3. The two readings (Rule 37)

- **(A) Guard files stay byte-identical.** "Same 30 guards green" means the files are untouched. To honour
  it, `bin/dispatch.sh` must retain working bash `is_ready` / `verify_delivered` / `prepare_effective_ref` /
  `do_inject` for the sourced path, while the main path execs the TS. Those four then exist **twice**.
- **(B) Guard files are re-pointed at the TS.** "Same 30 guards green" means the same 30 assertions still
  pass against live code; 12 invocation lines change to call a TS probe surface instead of sourcing bash.

## 4. Recommendation — (B), and I would not ship (A)

(A) produces **12 green guards measuring dead code**: the bash `is_ready` they exercise is no longer the
`is_ready` production runs, and the two copies drift silently. That is precisely the silent-measurement
defect class `#900` and `run-all.sh`'s whole skip-set assertion exist to catch, re-entering through the
front door wearing a passing test as a disguise. The ref's own Rule 29 framing ("dispatch.sh only + its
shim, **+ tests**") already puts tests in scope.

Proposed (B), keeping the ref's exec-shim shape exactly as written:

- `bin/dispatch.sh` = the prescribed 3-line exec shim. PATH entrypoint, `bin/init/manifest.mjs`, T96
  ship-set and every caller untouched — as the ref intends.
- The TS CLI gains a hidden `__probe` subcommand exposing the same four behaviours as exit codes, which is
  what the guards actually assert on:
  - `dispatch.sh __probe is-ready <sid> <cli>` → exit 0/1 (replaces 8 guards' `if is_ready …`)
  - `dispatch.sh __probe verify-delivered --ref <f> <sid>` → exit 0/1/2 (the existing three-way #835 result)
  - `dispatch.sh __probe prepare-ref --ref <f>` → prints the effective ref path (T67)
- Diff per guard: **one line** (`source …` + call → one `__probe` call). Fixtures, `STUB_SCREEN_FILE`,
  `TELEPTY` stub, `lib.sh` all unchanged — the guards keep measuring the same fixtures through the same stub.
- One new knob needed: `verify_delivered`'s hard-coded `sleep 5` (dispatch.sh:418) is currently stubbed by
  redefining the `sleep` builtin, which is impossible across a process boundary. Proposal:
  `AIGENTRY_DISPATCH_VERIFY_SLEEP_MS` (default 5000), set to 0 by T6/T7/T91. This is a new env var, hence
  part of what I am holding on.
- `EXPECTED_GUARDS` stays 97 (no guard added or removed, so the #900 manifest assertion is untouched).

## 5. What I need decided

1. **(A) or (B)?** I recommend (B).
2. If (B): confirm that editing 12 guard invocation lines is within the ref's "same 30 guards green"
   success criterion, and that `AIGENTRY_DISPATCH_VERIFY_SLEEP_MS` is an acceptable new knob.
3. Confirm `DISPATCH_SH_NO_MAIN=1` sourceable-library mode may be **dropped** from the shim under (B).
   Nothing outside `tests/dispatch/` references it (measured: `grep -rn DISPATCH_SH_NO_MAIN` hits only
   `bin/dispatch.sh` and the 12 guards), but it is an undocumented public-ish surface and dropping it is a
   contract deletion, not a port.

## 6. Contract enumerated so far (port is being written against this)

Flags (dispatch.sh:158-179) — re-measured, matches the ref's list exactly, 15 flags plus `-h|--help`:
`--target --ref --from --timeout-ms --spawn-and-dispatch --track --name --cwd --worktree --cli --role
--task --no-task --verify-delivered --no-verify-started --keep-alive`.
Defaults: `timeout_ms=30000`, `cli=claude`, `verify_started=1`, all others empty/0.

Exit codes (`grep -nE 'exit [0-9]+'`, 20 live sites):

| Code | Meaning | Sites | Pinned by |
|---|---|---|---|
| 0 | dispatched + recorded | :176 (--help), :600, :792 | T4, T60, T94 |
| 1 | REPL-ready timeout | via `wait_for_ready` :711 | T60 |
| 2 | spawn failed | :672, :687, :698 | T49 |
| 3 | inject failed / ref-prep failed | :712, :743 | T51 |
| 4 | usage | :177, :182, :183, :497, :504, :510, :608, :615 | T59 (task-gate), T49 |
| 5 | DELIVERY_FAILED (--verify-delivered) | :766 | T7 |
| 6 | never registered (#727) | `wait_for_ready` → `exit $?` :711 | T60 |
| 7 | DELIVERY_UNKNOWN / RETRY_HELD | :729, :751, :764 | T78, T79, T91 |
| 8 | DEDUPLICATED_NO_NEW_DELIVERY | :726 | T74 |
| 9 | DISPATCH_NOT_RECORDED | :634, :732 | T70, T78 |

Only stdout contract line: `OK dispatched to $sid` (:774). Everything else is stderr, all prefixed
`dispatch.sh: `. Full stderr line inventory + guard mapping lands in the final report.

Subprocesses kept as subprocesses with identical argv (not absorbed): `open-session.sh`,
`boot-prepare.mjs`, `dispatch-registry.py`, `dispatch-verify.sh`, `session-probe.py`,
`orchestrator-report-target.sh`, `emit-telemetry.mjs`, `telepty`.

## 7. Not yet checked

`process.platform` branch inventory, Snyk, PR/CI. No production daemon, `orchestrator` session,
launchctl, or main-tree file was touched; all work is confined to the worktree.
