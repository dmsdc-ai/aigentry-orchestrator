# Task #1136: exact candidate boundary retest

Measured 2026-09-11 08:46:53–08:46:57 UTC in `/Users/duckyoungkim/.aigentry/worktrees/qvpath1136`. The exact candidate passed all 18 unchanged standalone tests. The contemporaneous baseline reproduced 9 passes and 9 failures. Baseline policy failures are not candidate failures.

| Separate run | Tests | Pass | Fail | Exit | Child timeouts | TAP duration | Wall duration |
|---|---:|---:|---:|---:|---:|---:|---:|
| Candidate | 18 | 18 | 0 | 0 | 0 | 857.757959 ms | 0.879762 s |
| Baseline control | 18 | 9 | 9 | 1 | 1 | 2760.857875 ms | 2.783209 s |

Both runs had zero cancelled, skipped, or todo tests. Each contains four selector rejection tests and fourteen helper invocation tests. Selector probes exited 1 before execution, with no marker created; these are expected passes. Candidate helper exits were three successes (0) and eleven refusals (7). Baseline FIFO reached the harness's 2000 ms child deadline, returned `ETIMEDOUT`, null status, and `SIGKILL`. Neither suite process timed out; no other child timeout, signal, or spawn error occurred. Top-level stderr files are empty; child stderr and assertion errors are retained in TAP diagnostics.

## Exact inputs and currentness

Hashes were recomputed and matched before execution and again after both runs. Both worktrees were clean before and after execution, before writing this report. No helper or harness changes were made.

| Input | SHA256 |
|---|---|
| `tests/dispatch/task-queue-path-boundary.test.cjs` | `deeeaa4024ba1c6f619e7880363141fb8860e73181654a5900e05044718be6cd` |
| Candidate `/Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py` | `fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a` |
| Baseline `bin/tq-write.py` in tester worktree | `12bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca` |

Candidate HEAD remained `e2ea7a7541dd28deba8448f01ee0fa6a54293631`; tester/harness HEAD remained `8a9f1786e68f60b39bef004151d8dfad86322f05`. Local `main` was `8a205a90a22e4a311dd4543681324fa3c9056b32` throughout. `git rev-list --left-right --count HEAD...main` measured candidate 8/66 and tester 9/66. Thus these are pinned worktree results, not verification of current main. No fetch, merge, publication, or remote-currentness claim.

Runtime: `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node`, version `v20.20.0`; harness-resolved Python `/opt/homebrew/bin/python3`, version `3.14.2`, real executable `/opt/homebrew/Cellar/python@3.14/3.14.2_1/Frameworks/Python.framework/Versions/3.14/bin/python3.14`. Platform: macOS 26.4.1, Darwin 25.4.0, arm64.

Direct candidate command (executed with stdout/stderr captured separately):

```sh
TQ_BOUNDARY_CANDIDATE=/Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py \
TQ_BOUNDARY_CANDIDATE_SHA256=fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a \
/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test \
/Users/duckyoungkim/.aigentry/worktrees/qvpath1136/tests/dispatch/task-queue-path-boundary.test.cjs
```

The separate baseline command used the same executable and arguments with both `TQ_BOUNDARY_CANDIDATE` and `TQ_BOUNDARY_CANDIDATE_SHA256` removed from the environment. The unchanged harness copies the verified helper bytes into temporary fixtures and checks their hash; it clears `TQ` for default invocations and supplies only the test-specific overrides. No live queue was written.

## Assertions and observed side effects

Candidate: default note append, default status compare-and-set, and helper-file symlink invocation exited 0, changed the intended local queue/state/lock, and left the foreign snapshot unchanged. All three nonempty TQ spellings and all eight unsafe/unavailable boundaries exited 7, preserving local queue, lock, state, and foreign snapshots exactly. Snapshots cover bytes, inode, mtime, mode, symlink target and directory entries as implemented in the unchanged harness.

Baseline failures below are exact test numbers from TAP. Every boundary row named below has the suffix `is refused without changing queue or foreign filesystem` in its full testcase name.

| Test | Testcase | First failed assertion / observed effect |
|---:|---|---|
| 7 | TQ absolute external cannot select a foreign queue | Foreign preservation; foreign queue write and sidecar creation, exit 0 |
| 8 | TQ relative external cannot select a foreign queue | Foreign preservation; foreign queue write and sidecar creation, exit 0 |
| 10 | helper file symlink invocation writes only its own physical workspace queue | Foreign preservation; foreign workspace queue write and lock creation, exit 0 |
| 11 | state directory symlink | Foreign preservation; foreign queue/lock changed, local queue/lock views also changed, exit 0 |
| 12 | queue symlink | Foreign preservation; foreign target/sidecar changed, exit 0 |
| 13 | lock sidecar symlink | Foreign preservation; foreign dangling lock target created, local queue/state changed, exit 0 |
| 14 | missing target | Lock preservation; new local lock and state entry despite exit 7 |
| 17 | queue directory | Lock preservation; new local lock and state entry despite exit 7 |
| 18 | FIFO | Must finish without timeout, signal, or spawn error; timed out and created local lock/state entry |

The other baseline cases passed: four selector guards, two default writes, TQ equal to workspace queue, missing target with existing lock, and missing state directory. Only the first three successful helper cases in that list changed local queue/state/lock; the two refusals preserved snapshots. Temporary fixtures are removed by the harness cleanup hooks. Observations concern fixture snapshots, not a system-wide filesystem audit.

## Raw evidence

Retained under ignored `/Users/duckyoungkim/.aigentry/worktrees/qvpath1136/dist/evidence/qvpath1136-retest/`; raw evidence is not committed. TAP includes all assertion details, selector errors, helper stdout/stderr, and before/after filesystem diagnostics. Metadata records commands, selected environment variables, runtimes, timing, pins, and before/after git currentness.

| File | SHA256 |
|---|---|
| `candidate.tap` | `9abb81717546c30e5caa3e0e6adb8712aca1d47f39ad40616cebffa44713ce4d` |
| `candidate.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `baseline.tap` | `84f93963bdcba67ab065fb69c5e3d9f6bd556afeeb77d8af14581cd9294eda96` |
| `baseline.stderr` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `metadata.json` | `6a4a2fcec47e523410b7113976f9ae77007e1f78cac4aad6934e8c9f8a059d63` |

Scope: standalone direct Node tests only, not npm/CI. Core56 belongs to a separate worker and was not run here. Static path tests do not cover dynamic directory swaps; no race experiment was performed. No build was run (tester-only scope). This phase authors documentation only, with no new or modified first-party code/testcode, so no Snyk code scan was triggered. Candidate has no failures in this measured scope; broader validation and review remain with the orchestrator.
