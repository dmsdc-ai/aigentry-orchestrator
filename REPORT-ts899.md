# ts899 (#899 tranche 1) — bin/dispatch.sh → TypeScript behind a CLI-compatible entrypoint

Branch `feat/899-t1-dispatch-ts` (worktree `~/.aigentry/worktrees/ts899`, off `origin/main` a9e2385).
Status: **done — both suites at baseline numbers, Snyk clean, PR open.**

---

## Resolved HOLD — T94 case H: the port removed the failure mode the assertion pinned

Mid-port, `run-all.sh` reported **96 passed, 1 failed** — `T94_dispatch_captures_inject_id.sh`:

```
FAIL: sid-nowrite-T94 transport.inject_id = 3a2a0e8e-1c4d-4f2b-9a77-8b1e5d6c0f31, want null
```

Case H (T94:154-176) makes TMPDIR unwritable and asserted three things:

1. `rc == 0` — id capture must not abort a delivery the registry already authorized. **Passes.**
2. `transport.result == write_observed`. **Passes.**
3. `transport.inject_id == null`. **Fails — the port captures the id.**

Why: the shell tee'd telepty's stdout through `mktemp "${TMPDIR:-/tmp}/dispatch-inject.XXXXXX"`
(dispatch.sh:372-388). An unwritable TMPDIR made `mktemp` fail, `out=""`, and the scrape was skipped —
so "no id" was a *consequence of the scratch file*, not a decision. The TS tees through an in-memory
buffer (`inject()`, `src/dispatch/cli.ts`), so there is no scratch file to fail and the id is read
normally. Assertions 1 and 2 — the invariant the case was written for, stated in its own comment
("capturing the id must never be able to FAIL a dispatch") — still hold.

**Resolution (orchestrator-approved, option B):** assertion 3 now pins the new truth — the id is captured
despite an unwritable TMPDIR — and T94's comment records that the old `null` was a side effect of the
`mktemp` scratch file, with the measurement. A scratch file was explicitly not reintroduced to reproduce
the defect. The rejected alternative was to re-add it for bit-exactness, which would have ported a
workaround forward as a requirement and left the tracker with `no_transport_inject_id` in a case where
nothing is wrong with the id.

Caveat worth keeping visible: under (B) case H no longer exercises a real degrade path, because in the TS
there is no fallible step left to degrade — `parseInjectId` is a pure regex over a string already in
memory. It still measures that an unwritable TMPDIR breaks nothing (rc 0 + `write_observed`).

---

## Baselines vs after — both suites

| Suite | Baseline (before any change) | After the port | Delta |
|---|---|---|---|
| `npm test` | `tests 225 / pass 225 / fail 0` | `tests 225 / pass 225 / fail 0` | none |
| `tests/dispatch/run-all.sh` | `guards: 97  passed: 97  failed: 0  skipped: 3` | `guards: 97  passed: 97  failed: 0  skipped: 3` | none |
| skip set | `T16 T48 T95` | `T16 T48 T95` | **unchanged** |
| Snyk `snyk_code_scan` (`src/dispatch/`) | — | `issueCount: 0` | 0 new |

`EXPECTED_GUARDS` stays 97: no guard added, none removed.

**Baseline trap, now documented in `tests/dispatch/run-all.sh`:** a fresh worktree measures
**93 passed / 4 failed, skip set `T16 T47 T48 T95`** and fires `SKIP-SET MISMATCH on darwin` until
`tsc -p .` has run. T17/T18/T24/T83 need `dist/src/session/inject-parser.js`; T47 needs `dist/`. None of
it is a code defect. It cost me one false baseline, hence the note the orchestrator asked for.

## The enumerated contract → what pins it

**Flags** (re-measured at dispatch.sh:158-179): the ref's list is exact — 15 flags plus `-h|--help`.
`--target --ref --from --timeout-ms --spawn-and-dispatch --track --name --cwd --worktree --cli --role
--task --no-task --verify-delivered --no-verify-started --keep-alive`.
Defaults preserved: `timeout_ms=30000`, `cli=claude`, `verify_started=1`, rest empty/0.

**Exit codes** (20 live `exit` sites → 10 distinct codes):

| Code | Meaning | Guard that pins it |
|---|---|---|
| 0 | dispatched AND recorded (+ `--help`) | T4, T60, T94 |
| 1 | REPL-ready timeout | T60 |
| 2 | spawn failed (`open-session.sh`, git guard) | T49 |
| 3 | inject failed / ref-prep failed closed | T51, T67 |
| 4 | usage (unknown arg, missing `--ref`, task-gate hard reject) | T59, T60 |
| 5 | `DELIVERY_FAILED` under `--verify-delivered` | T7 |
| 6 | session never registered (#727) | T60 |
| 7 | `DELIVERY_UNKNOWN` / `RETRY_HELD` | T78, T79, T91 |
| 8 | `DEDUPLICATED_NO_NEW_DELIVERY` | T74 |
| 9 | `DISPATCH_NOT_RECORDED` | T70, T78 |

**Output lines.** One stdout contract line: `OK dispatched to <sid>` — plus telepty's own inject stdout,
which is tee'd through rather than swallowed (T94 case G pins that it still reaches stdout). Every other
line is stderr, all `dispatch.sh: `-prefixed, ported verbatim including the `⚠️ Rule 33` line.
`--help` is byte-identical to the pre-port `sed -n '2,41p'` output — diffed against a saved baseline,
zero differences, and T60 re-asserts `AIGENTRY_DISPATCH_REGISTER_TIMEOUT_MS` + `180000` appear in it.

**Subprocesses — kept as subprocesses, same argv, none absorbed:** `open-session.sh`, `boot-prepare.mjs`,
`dispatch-registry.py`, `dispatch-verify.sh`, `session-probe.py`, `orchestrator-report-target.sh`,
`emit-telemetry.mjs`, `telepty`, `git`, `ps`. The REPL-ready probe still delegates to `session-probe.py`
and only reads its verdict — its documented false-negatives are untouched.

**State files** (`state/dispatch/active.json` etc.) — still written only by `dispatch-registry.py`.

Only the inline `python3 -c` blocks became TS (sha256, `now_ms`, `telepty list` parsing, the
verify-delivered screen analysis, the task-gate queue read, the task-ledger write). Those were the
shell-dialect fragility this tranche targets, not components. The ledger writer keeps python's
`json.dumps(..., ensure_ascii=False, indent=1)` shape via `JSON.stringify(data, null, 1)` plus the same
same-dir-temp + fsync + rename, so `state/task-queue.json` diffs stay reviewable.

## Entrypoint shape

`bin/dispatch.sh` is the exec shim the ref specified, plus two lines that are load-bearing rather than
decorative:

```bash
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"   # was dispatch.sh:63
DISPATCH_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"; export DISPATCH_SCRIPT_DIR
exec node "$DISPATCH_SCRIPT_DIR/../dist/src/dispatch/cli.js" "$@"
```

`SCRIPT_DIR` is exported rather than derived from `import.meta.url` so a symlinked entrypoint resolves
`bin/` helpers exactly as bash did. `bin/init/manifest.mjs`, the T96 ship-set agreement and every caller
are untouched.

## `process.platform` branches

**Zero.** Measured: `grep -n "process.platform\|os.platform" src/dispatch/*.ts` → no matches. The shell
had no OS-specific arm to mirror (no `uname` branch, no BSD/GNU fork) — the bash-3.2 accommodations it
carried, like the two-branch `record_transport` that avoided expanding an empty array under `set -u`,
are exactly the fragility that disappears rather than becoming a platform check.

## Contract deletions and additions (Rule 38)

1. **Deleted: `DISPATCH_SH_NO_MAIN=1` sourceable-library mode.** Measured before removing:
   `grep -rn DISPATCH_SH_NO_MAIN` matched only `bin/dispatch.sh` itself and 12 guards under
   `tests/dispatch/`. No caller, no other script, nothing in `bin/`. Recorded in the shim header.
2. **Added: `AIGENTRY_DISPATCH_VERIFY_SLEEP_MS`** (default 5000), replacing the hard-coded `sleep 5` in
   `verify_delivered`. The guards used to skip that wait by redefining the `sleep` builtin, which cannot
   cross a process boundary. Recorded in the shim header.
3. **Added: the internal `__probe` subcommand** — `is-ready`, `verify-delivered`, `dispatch-ref`. Not a
   flag, not in `--help`, no caller outside `tests/dispatch/`.

The 12 re-pointed guards (T4 T5 T11 T12 T13 T14 T15 T50 → `is-ready`; T6 T7 T91 → `verify-delivered`;
T67 → `dispatch-ref`) keep their fixtures, `lib.sh`, `STUB_SCREEN_FILE` and telepty stub unchanged. All
12 pass against the TS.

## Bugs the guards caught in my port (both fixed)

- **T47** — I emitted `exec -a 'codex'` where bash `printf '%q'` emits `exec -a codex`; T47
  string-matches the launcher body. My earlier claim that no guard asserts on launcher content was wrong
  — I had grepped only T28/T34. `shellQuote` now emits shell-safe words bare, exactly as `%q` does.
  T47 passes both legs (codex + gemini, real spawns).
- **T94 case H** — see above; resolved as a superseded assertion, not a port bug.

## What I did NOT check

- **Live dispatch behaviour is untested by me.** Every guard drives a stubbed `telepty`; T16/T48/T95 stay
  skipped exactly as at baseline. The first real spawn-and-dispatch through the TS will happen when
  someone merges this, and the paths only live dispatch exercises — `open-session.sh` spawning a real
  workspace, `boot-prepare.mjs` role wiring end to end, the registration wait against a real daemon —
  have no non-live coverage.
- I did not touch the production daemon on :3848, the `orchestrator` session, launchctl, or any file in
  the main tree; no process I did not spawn was signalled. All work is confined to the worktree.
