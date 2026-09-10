# Pinned compiled queue boundary runtime — 2026-09-10

Actual single-file Node 20 execution: **56 discovered, 51 passed, 5 failed, 0 skipped, 0 cancelled, 0 todo; exit 1**. All five failures match the five prior direct Python witnesses. No setup/harness failure or retry. Parent task #1136 remains incomplete; HOLD for bounded fix review, no fix or live activation performed.

## Provenance and currentness

- Worktree: `/Users/duckyoungkim/.aigentry/worktrees/qt1136b`; branch `test/1136-queue-boundary-runtime`.
- Execution HEAD/base: `16358f3fd11fc968ff32c72c6900e6d906c45a93`; report commit is the containing commit. Initial and post-run tracked tree clean; this report is the sole tracked change.
- Test source commit: `c75d360bde57d1f1f5859712931c5b4cb577cb8b`; helper candidate from `d361397a6b3a75e7aa98c2612726ecbef9911cf2`.
- Local main initially `2bfdf107fde86411fd78611fa4c0e406e28a2a4d`; post-run report sample `922c22b092a19abf96bdabfe76110805799922bb`. Main moved independently; no fetch/main writes.
- Against both samples, helper and test are absent from main (`git diff --name-status main HEAD` reports both `A`). Package, lock, tsconfig and runner match sampled main. No repository-wide parity claim.

| Artifact | Git blob | SHA-256 |
| --- | --- | --- |
| `bin/tq-write.py` | `c6654295b5614e18cd3ab4b70e18e6314e48b03f` | `7e6e6dd1ebe210d1a772e382234be4d31d4939e62db5512b3a70a4304a4de417` |
| `tests/dispatch/workflow-task-writer.test.ts` | `46bc236a774ef8c458afd609a5994c01726eefe7` | `be3afa7c4eae51f0f4e0afc509c112fa984c3f741cb90d18a9e1218f5d1adfd2` |
| `dist/tests/dispatch/workflow-task-writer.test.js` | ignored compiled artifact | `d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f` |
| `package.json` | unchanged | `2b56fef3f0924d72bdef42c7e50a4a122ade11173bb979dfc087d63fe9d3465a` |
| `package-lock.json` | unchanged | `3a5943e964919ab28eea9452fb68239341d0640ee1b8e57f0683aa62accef788` |
| `tsconfig.json` | unchanged | `7f867214418ae3ed617dba351c2d4c99064b8e7afd3b9a0d34ece8cc8a94bc97` |
| `scripts/run-tests.mjs` | unchanged, read only | `5a689e7320ad70c2357f99e4527ce4fade966964f2af2c9218471a08bd35f31b` |

Helper/source/compiled hashes were remeasured before and after execution and matched. Copied the authorized builder artifact from `/Users/duckyoungkim/.aigentry/worktrees/qb1136b/dist/tests/dispatch/workflow-task-writer.test.js` byte-for-byte into a new regular file; no symlink or compilation.

## Execution and isolation

Read TS, compiled JS, helper and runner before test execution; no test import during review. Compiled JS imports Node built-ins only. Its `resolve(import.meta.dirname, '../../..')` resolves to the qt1136b worktree above; helper resolves to that worktree's regular `bin/tq-write.py`, not main or builder checkout. Parent path components were checked against symlinks before copying.

Exact command, cwd as above:

```sh
/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test dist/tests/dispatch/workflow-task-writer.test.js
```

- Measured Node `--version`: `v20.20.0`; selected test Python `/opt/homebrew/bin/python3`, measured `Python 3.14.2`.
- Start UTC: `2026-09-10T11:07:12.514483+00:00`; outer elapsed `14438.452917 ms`; TAP duration `14415.697625 ms`.
- Outer Python subprocess capture with 90-second timeout; timeout did not fire. Node exit 1; wrapper exit 0 means evidence capture completed, not tests passed.
- Complete outer environment: `PATH=/usr/bin:/bin`, `HOME=/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-evidence/home`, `TMPDIR=/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-evidence/tmp`.
- Retained fixtures create synthetic queue/home/tmp roots and replace child environment with synthetic `TQ`, `AIGENTRY_HOME`, `AIGENTRY_ROOT`, `AIGENTRY_TARGET_CWD`, HOME/TMPDIR and minimal PATH. Fault harness adds `PYTHONDONTWRITEBYTECODE=1`. No inherited credentials/live-state paths or session commands in tests.
- Bounded child calls are joined, including parallel allSettled and locker close. Outer process was joined; `killpg(pid, 0)` returned ProcessLookupError after completion, confirming no remaining process in its group.
- Actual TAP plan `1..56`, tests 56, suites 0, pass 51, fail 5, cancelled/skipped/todo 0. Independently observed execution agrees with source's 29 original + 27 added cases; that source count was not used as discovery evidence.

## Exact failed tests and assertions

| TAP # / exact test name | Actual evidence and failed assertion |
| --- | --- |
| 32 — `note boundary null: clarified missing versus present contract` | Expected exit 4, actual 0. `unchanged=false`; note became `segment` with a new ledger. Strict JSON, mode 0640, no own temp, foreign sentinel retained. |
| 44 — `numeric identity 1000000000000000000000 uses JS text and preserves stored value/type` | JS requested `1e+21`; expected 0, actual 3 `UNKNOWN_TASK`. Queue unchanged; Python harness reports stored ID type/value preserved. |
| 45 — `numeric identity 9007199254740993 uses JS text and preserves stored value/type` | JS requested `9007199254740992`; expected 0, actual 3 `UNKNOWN_TASK`. Queue unchanged; Python harness reports stored ID type/value preserved. |
| 55 — `encoding overflow refuses with 4 MALFORMED_QUEUE unchanged and no own temp` | Expected 4, actual 0; unrelated raw `1e400` yielded `unchanged=false`, `strict=false`, `document=null`. No own temp; mode 0640 and foreign sentinel retained. |
| 56 — `encoding surrogate refuses with 4 MALFORMED_QUEUE unchanged and no own temp` | First failed assertion is cleanBoundary's empty leak list: actual `[".tq-write.plkpy56n.tmp"]`. Captured helper exit 1, UnicodeEncodeError at tq-write.py:179; unchanged=true, mode 0640, foreign sentinel retained. Later exit-4/token/unchanged assertions were not reached. |

These are five `testCodeFailure` / `ERR_ASSERTION` failures, not harness launch/transport failures. Names map one-to-one to prior null, two integer, overflow and surrogate witnesses; no added/missing failure. The current overflow TAP establishes invalid strict JSON after replacement, while the exact Infinity token was prior diagnostic evidence (not printed by this TAP). Surrogate rejection by Python's UTF-8 writer is captured in current TAP. Its own-temp leak is observed before the fixture removes its synthetic directory.

## Passing controls measured in this run

- Original cases 1–29 all pass: preservation of fields/Unicode/newline/ID types; exact replay and reordered argv no-write; payload conflict 6; same/different-row concurrent appends; identical op-id once; focus/note preservation; CAS exactly one winner and stale exit 5; usage/unknown/malformed refusals unchanged.
- `held sidecar lock times out with exit 7, no partial state, then recovers`: passes 10-second minimum assertion, LOCK_TIMEOUT token, unchanged snapshot and recovery; full test duration `10149.123417 ms`. Unusable lock path returns 7 QUEUE_UNAVAILABLE unchanged.
- `note boundary missing/empty/nonempty: clarified missing versus present contract` pass with expected segment/separator; list and number notes return 4 unchanged.
- `numeric identity <literal> uses JS text and preserves stored value/type` passes for `7.0`, `-0`, `642.2`, `690.1`, `697.1`, `1e-7`, `1e-6`, `1e21`, and `"007"`.
- `identity refusal/control <case> requested <text>` passes: ambiguous/7 =>2 unchanged, leadingzero/007 =>0 changing only string row, id:7.0/7.0 =>3 unchanged, id:true/1 =>3 unchanged, id:1e400/Infinity =>4 unchanged.
- `commit fault regular separates precommit refusal from visible replacement` and corresponding `replace` pass: injected precommit error =>7, bytes/inode/timestamps unchanged, no real replacement event or own-temp leak.
- `commit fault directory separates precommit refusal from visible replacement` passes: events `[regular,replaced,directory]`, exit 8 after real replace, visible note and op ledger, exact replay exit 0 with unchanged snapshot.
- All 27 boundary results checked empty own-temp first; only surrogate failed that check. The other 26 then passed foreign sentinel and mode 0640 assertions. Surrogate's diagnostic itself reports foreign/mode preserved, but those two assertions were not reached.

## Retained raw evidence

Ignored directory: `/Users/duckyoungkim/.aigentry/worktrees/qt1136b/dist/queue-boundary-evidence/`.

| File | SHA-256 |
| --- | --- |
| `stdout.tap` — complete TAP and assertion diagnostics | `de3337b9a1122a0a06e83ebc646553e38bc19b2487aa3c46dbd4c0efa1ba8a6c` |
| `stderr.txt` — empty outer stderr; child diagnostics are in TAP | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `run.json` — argv/cwd/environment/runtime/exit/timing/isolation | `2ae312c7e1bf06be3edb0261c965b6e5c2e7cf80611619e1013ba21c8c6d915e` |

## Limits and security scope

One exact compiled JS execution only; no deterministic-failure rerun, npm test, runner/guard execution, other suites, builds, installs, source edits, app/daemon/reconciler/model execution, live queue access, remote push, or path-containment implementation. Snapshot checks establish observed bytes/inode/timestamps, not every syscall. Fault injection does not establish real power-loss durability. No candidate fixes or live callers were tested.

Builder's separate report at base 16358f3 records build exit 0 on Node 25.2.1/npm 11.6.2/TS 5.9.3 in 1074.23 ms; this tester did not build. Its shared dependency tree had missing declared telepty and extraneous packages, so no clean-install claim. Historical 29/29 old JS and 22/27 direct Python results remain separate runs; current execution is the new JS's 51/56.

Snyk N/A: report-only tracked change and exact copy of already compiled JS, no authored first-party code changes. Prior tester zero-issue scan covers only `tests/dispatch/workflow-task-writer.test.ts`; helper's separate 2 LOW findings remain unresolved. No inherited waiver, same-file disagreement, new scan or security acceptance claim.
