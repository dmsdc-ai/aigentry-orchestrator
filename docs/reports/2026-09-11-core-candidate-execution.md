# Task #1136: pinned compiled core candidate execution

One exact compiled-suite run on 2026-09-11: **56 tests, 55 passed, 1 failed, 0 skipped, 0 cancelled, 0 todo; Node exit 1**. TAP duration: **14318.926 ms**. Harness wall duration: **14362.535 ms**. Integration review is required; this is not a readiness claim.

## Selection and independently verified pins

All supplied file hashes and commit objects matched before and after execution. The source and helper bytes were also independently compared with the corresponding committed blobs. Inputs were not edited or rebuilt.

| Input | Commit / SHA-256 |
|---|---|
| Compiled JS | `0679b21f234a1fb492675091cfa7a494b1fbf3804afdbbba73d0aa1a445c3bf5` |
| Test source commit | `8f23ceed7ca663ae3ba3455781ddf9a776ee68d6` |
| Test source SHA-256 | `1547a6f298cefa363863d722993e842e3b9b97c537eb45fcd61166bfad7e8db9` |
| Candidate commit | `e2ea7a7541dd28deba8448f01ee0fa6a54293631` |
| Candidate SHA-256 | `fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a` |

Compiled input: `/Users/duckyoungkim/.aigentry/worktrees/qbcore1136/dist/tests/dispatch/workflow-task-writer.test.js`.
Source input: `/Users/duckyoungkim/.aigentry/worktrees/qbcore1136/tests/dispatch/workflow-task-writer.test.ts`.
Candidate input: `/Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py`.

Builder HEAD was `44fab385a38b247be27e16a520f6ca0814986189`; candidate HEAD was the candidate commit above. The selected tracked test source and helper had clean path-specific Git status before and after. This checks retained artifact bytes and source provenance; compilation was not reproduced.

## Exact execution

Working directory: `/Users/duckyoungkim/.aigentry/worktrees/qrcore1136`.

```text
/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test /Users/duckyoungkim/.aigentry/worktrees/qbcore1136/dist/tests/dispatch/workflow-task-writer.test.js
```

The harness supplied this complete environment, without inheriting live queue settings:

```text
PATH=/usr/bin:/bin
HOME=/Users/duckyoungkim/.aigentry/worktrees/qrcore1136/dist/evidence/qrcore1136/home
TMPDIR=/Users/duckyoungkim/.aigentry/worktrees/qrcore1136/dist/evidence/qrcore1136/tmp
QUEUE_WRITER_HELPER=/Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py
QUEUE_WRITER_HELPER_SHA256=fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a
```

Runtime: Node `v20.20.0`; suite-selected Python `/opt/homebrew/bin/python3`, `Python 3.14.2`; Darwin `25.4.0`, arm64. Full platform string is in `run.json`.

Started `2026-09-11T09:02:16.990128+00:00`; finished `2026-09-11T09:02:31.352596+00:00`. Harness timeout was 180 seconds, with a dedicated owned process group (PID 55930) and kill-on-timeout handling. **No harness timeout occurred and no harness kill was needed.** This was a test assertion failure. The expected held-lock timeout/recovery test passed; there was no reported test-runner timeout. Outer stderr was empty; helper stderr for the failing case was captured inside TAP assertion diagnostics.

The suite copies the selected helper into each disposable fixture's `bin/tq-write.py` and asserts the copied SHA-256. Its queue is the corresponding synthetic `state/task-queue.json`; no live queue writes were performed.

## Failure and reached behavior

Actual TAP enumeration was `1..56`, with 56 named top-level result records (Node reports `suites 0`). The complete ordered enumeration and per-test durations are preserved in `stdout.tap`; the prior expected count was not used as a result.

**Test 4: `parallel appends preserve every segment (same rows)` failed** at compiled JS line 227, declared at line 222. The assertion was:

```javascript
assert.ok(results.every(result => result.code === 0), JSON.stringify(results));
```

Expected `true`, actual `false`, `ERR_ASSERTION` / `testCodeFailure`. All twelve helper calls completed: eleven returned 0; the third result returned **7**, stdout empty, stderr:

```text
QUEUE_UNAVAILABLE: queue is not a stable regular file
```

The intended same-row concurrent helper workload was reached: twelve appends targeted task `7` with distinct segments and operation IDs. This case does not inject a fault. It failed at the all-success assertion, so the subsequent queue segment-preservation assertions were **not reached**. The evidence does not establish lost segments or the precise syscall interleaving. The candidate emits this diagnostic from `open_queue()` when file type or descriptor-versus-path identity checks fail; no root-cause repair or additional diagnostic run was performed.

Tests 1–3 and 5–56 passed. These include different-row parallel appends, identical operation replay/concurrency, focus/note and compare-and-set concurrency, refusal and malformed-data controls, lock timeout/recovery, numeric and note boundaries, regular-file-fsync/replace/directory-fsync fault cases, and encoding refusals. Those individual passes do not override the failed same-row acceptance case. There was one attempt; repeatability and intermittent-failure frequency were not measured.

## Raw evidence integrity

All paths below are relative to `/Users/duckyoungkim/.aigentry/worktrees/qrcore1136/dist/evidence/qrcore1136/`, verified ignored by Git. Raw evidence stays local and is not included in the report commit.

| File | SHA-256 |
|---|---|
| `stdout.tap` | `52de9af20e940a0c480ada3596898b825c5adc5192c08a77bc4f6ba63c48f8a8` |
| `stderr.log` (empty) | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| `run.json` | `0150aa9bc3eb073fe5a8e2dc84c92e01523243ced0285025093c368d93664cee` |
| `pins-before.json` | `9272db9e1376b3d83718bd09159aec27d4f31e96ff24796b8f603a2e0ab6b474` |
| `pins-after.json` | `da9c4b799f395a121cf655a14950d61cce67cc82e9e05c1549cbb6aa27c047ec` |

## Currentness and limitations

Before and after the run, local `main` was `3a0f624894d7372023aa5ce942b2ec600264d65a`; neither `bin/tq-write.py` nor `tests/dispatch/workflow-task-writer.test.ts` existed in that commit. Tester HEAD before reporting was `24bd4e0615d4457aad73496003460a84e2698c51`. Results apply to the exact candidate and compiled artifact, not current main. No remote fetch or remote-currentness claim.

Only this compiled core file was executed. The separate reported 18 boundary passes are not added to these totals. Dynamic-race acceptance outside this suite, CI selection, install behavior, live caller wiring, real fault/power-loss durability, and broader readiness were not evaluated. No build, dependency install, generated JS/source/helper edit, fixture regeneration, application/daemon operation, or global configuration change occurred.

Builder-reported npm-ci dependency findings were **2 moderate and 1 high**; they were not independently assessed or remediated here. Snyk is **N/A for this report-only change**: no first-party code or temporary test code was authored or modified. No comprehensive security claim.

`TEST_REPORT: suite=workflow-task-writer.test.js total=56 passed=55 failed=1 skipped=0 cancelled=0 duration_ms=14318.926 exit=1 candidate=e2ea7a7541dd28deba8448f01ee0fa6a54293631 candidate_sha256=fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a`
