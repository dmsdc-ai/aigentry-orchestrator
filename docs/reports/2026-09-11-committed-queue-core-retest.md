# Committed queue-core retest — 2026-09-11

**Result:** one isolated `node --test` of the pinned compiled JS against this worktree's committed helper exited 0. TAP discovered 56, passed 56, failed 0, skipped 0, cancelled 0. This does not activate the autonomous loop.

## Checkout and currentness

- Worker: `qv1136-tester`; task #1136; branch `test/1136-committed-core-retest`.
- HEAD / retained helper commit (base): `fd014a1209c6da074c3640eea8606902a4c763af` (`fix(tq-write): apply tested queue-boundary correction (#1136)`).
- Merge-base with local main: `4ff94cda2f62e55a84e7b6d134f6fe0e02b2628c`.
- Local main, remeasured: `c6945d610f291cdf824e45841e343277f0bded4f` (`chore(1136): start approved path contract and committed-core retest`). Dispatch pin `d974fa6` was stale. `bin/tq-write.py` and `tests/dispatch/workflow-task-writer.test.ts` are absent from local main.
- `origin/main`: `a536cd8b303f6781ccccc9f4817aa8a6c0416845`; helper/test also absent.

## Pins (remeasured)

| Artifact | SHA-256 / git |
|---|---|
| This WT `bin/tq-write.py` (HEAD blob `5f909464c1db8ba0c40bf6dc90217831a083acac`) | `12bce41dc9a5901c08e134235d3ce1008d1aa1a7ed8a34ab82ad8332abfccdca` |
| Pinned compiled JS `qb1136b/dist/tests/dispatch/workflow-task-writer.test.js` | `d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f` |
| Copied ignored `dist/tests/dispatch/workflow-task-writer.test.js` (regular file, byte-identical) | same as pinned compiled JS |
| Pinned TS `qt1136` HEAD `c75d360bde57d1f1f5859712931c5b4cb577cb8b` | `be3afa7c4eae51f0f4e0afc509c112fa984c3f741cb90d18a9e1218f5d1adfd2` |
| This WT tracked TS (not executed; blob `3b2ee8fc5cefd7ca078b1d03456b3b37cf5b378b`) | `1550394df319c15a7243e4d9e265fc8c0c0e35deb6cefb60e6a2d3f45bc2309b` |

## Isolation

- Read compiled JS before copy: `REPO = resolve(import.meta.dirname, '../../..')`; `HELPER = join(REPO, 'bin/tq-write.py')`.
- After copy, dirname `/Users/duckyoungkim/.aigentry/worktrees/qv1136/dist/tests/dispatch` resolves REPO to this worktree and HELPER to this committed `bin/tq-write.py` (hash above). Not main, not qb1136b/qt1136.
- Fixtures: `mkdtempSync` plus synthetic `HOME`/`TMPDIR`/`TQ`; `AIGENTRY_HOME`/`ROOT`/`TARGET_CWD` set to the fixture root; fixture `PATH=/usr/bin:/bin`. No live queue, session, or credential paths in the JS env.
- Outer process env keys only: `PATH=/usr/bin:/bin`, synthetic `HOME`/`TMPDIR` under `dist/evidence/qv1136/outer-*`, `LANG=C`, `LC_ALL=C`, `TZ=UTC`. No `TQ`, `AIGENTRY_*`, `TELEPTY_*`, or credentials.

## Command (once; no rerun)

- Cwd: `/Users/duckyoungkim/.aigentry/worktrees/qv1136`
- Argv: `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node --test dist/tests/dispatch/workflow-task-writer.test.js`
- Node `--version`: `v20.20.0`
- JS Python lookup first existing: `/opt/homebrew/bin/python3` (`Python 3.14.2`)
- Outer timeout 90s did not fire.
- Start UTC: `2026-09-10T23:11:43.141975Z`; finish UTC: `2026-09-10T23:11:57.436395Z`
- Wrapper wall: `14294.42ms`; TAP `# duration_ms 14264.809917`
- Runner exit: `0`; stderr empty.

## TAP (unmodified)

```
TAP version 13
1..56
# tests 56
# suites 0
# pass 56
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 14264.809917
```

Named failures: none. `ok` lines: 56. `not ok` lines: 0.

Prior isolated-copy 56/56 is comparison only; this is committed-source execution of the pinned JS against this worktree helper.

## Evidence (ignored, retained)

| Path | SHA-256 | bytes |
|---|---|---|
| `dist/evidence/qv1136/stdout.txt` (TAP) | `ec251f04ac82eed4986172ffbbc0d9a44de5748e12adfb1739a0951bf8fb0662` | 10133 |
| `dist/evidence/qv1136/stderr.txt` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` | 0 |
| `dist/evidence/qv1136/meta.json` | `a57f50c40f89d51fe3ab7e352fa89447a9a305990248d35b40713a26395b0d71` | 8510 |

Node test pgid 55128 joined before leftover scan. The scan then matched the wrapper zsh command line (it contains the test filename) and SIGKILL'd pid 55100 after TAP was complete; no `tq-write.py` or `queue-writer-core-*` processes remained. Outer TMPDIR empty after join.

## Limits

- P1-base implements note-append / status / focus only, not claim/grant/receipt. Passing this suite cannot activate the loop.
- Source-hash equality is not runtime proof; this report is the runtime proof for this pin set only.
- NOT RUN: npm test, other suites, `scripts/run-tests.mjs`, guard runner, app/reconciler/telepty runtime, model calls, build/transpile, installs, live queue.
- NOT CLAIMED: full-loop, E2E, installed/npm closure, security waiver. Snyk N/A (report plus unchanged artifact copy only).
- Production workspace-contained queue policy is a separate lane and was not merged into this run.
