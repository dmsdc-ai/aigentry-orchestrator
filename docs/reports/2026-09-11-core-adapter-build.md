# Task #1136: pinned core adapter compilation

Compilation succeeded on 2026-09-11 at 08:58:16 UTC. This is compile-only evidence; no tests or application were executed and no assertion-pass claim is made.

## Tree and runtime pins

- Worktree: `/Users/duckyoungkim/.aigentry/worktrees/qbcore1136`.
- Branch: `build/1136-core-adapter`.
- Build source/base commit (HEAD before and after compilation): `8f23ceed7ca663ae3ba3455781ddf9a776ee68d6`, matching the dispatch.
- Local `main` at initial inspection: `8b08c0c7787c340b68a99f468a7983e102b22e5b`; at build measurements: `ec0fd17be449cc2a9b8e9491621bd2c926a64300`. Main moved independently; this build measures the pinned base, not current main. The pinned HEAD/main comparison was 11/68 unique commits.
- The report commit is the commit introducing this file; its exact hash is included in the upstream REPORT after commit creation.
- Node: `v20.20.0`, executable `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node`.
- npm: `10.8.2`, from the same Node installation; TypeScript: `5.9.3`.
- Installed direct dependencies: `@dmsdc-ai/aigentry-logger@0.2.0`, `@dmsdc-ai/aigentry-ssot@1.0.0`, `@dmsdc-ai/aigentry-telepty@0.8.0`, `@types/node@20.19.41`, `typescript@5.9.3`.
- Dependencies were initially absent. Local `npm ci` exited 0; no global install or lockfile rewrite. Its audit summary reported 3 vulnerabilities (2 moderate, 1 high); remediation was outside this compile-only scope.

## Command and compiler evidence

With `PATH="$HOME/.nvm/versions/node/v20.20.0/bin:$PATH"`, ran `npm run build`, which invokes `tsc -p .`. Exit: **0**. Compiler stderr: empty. Captured stdout:

```text
> @dmsdc-ai/aigentry-orchestrator@0.2.0 build
> tsc -p .
```

Raw evidence is local and ignored under `dist/evidence/qbcore1136/`: `before.txt`, `after.txt`, `tsc-version.txt`, `dependencies.txt`, `npm-ci.stdout.log`, `npm-ci.stderr.log`, `npm-ci.exit`, `build.stdout.log`, `build.stderr.log`, and `build.exit`.

## Independently measured SHA256

| File | Before compilation | After compilation |
| --- | --- | --- |
| `tests/dispatch/workflow-task-writer.test.ts` | `1547a6f298cefa363863d722993e842e3b9b97c537eb45fcd61166bfad7e8db9` | `1547a6f298cefa363863d722993e842e3b9b97c537eb45fcd61166bfad7e8db9` |
| `package-lock.json` | `3a5943e964919ab28eea9452fb68239341d0640ee1b8e57f0683aa62accef788` | `3a5943e964919ab28eea9452fb68239341d0640ee1b8e57f0683aa62accef788` |
| `dist/tests/dispatch/workflow-task-writer.test.js` | Absent; `dist` did not exist at initial inspection | `0679b21f234a1fb492675091cfa7a494b1fbf3804afdbbba73d0aa1a445c3bf5` |

The generated JS exists in this worktree's own `dist` directory, which is not a symlink. The source matches the requested pin both before and after compilation. The tracked tree was clean before installation and after compilation; `git diff --exit-code` succeeded. Only this report is a tracked output. No source edits, cleanup command, helper execution, daemon action, queue mutation, publish, or activation occurred. Snyk is N/A for this docs-only change; the authored test scan belongs to the preceding tester.

## Independent tester handoff

The tester must independently execute the exact generated artifact above. Dispatch-supplied candidate context, not verified by this build: `QUEUE_WRITER_HELPER=/Users/duckyoungkim/.aigentry/worktrees/qcpath1136/bin/tq-write.py`, `QUEUE_WRITER_HELPER_SHA256=fdb94e9c552c233510c5cd72d74b5c48d2acb90109460751f392ec23f5196f1a`, candidate commit `e2ea7a7541dd28deba8448f01ee0fa6a54293631`. This build tree's older `bin/tq-write.py` was retained and was not run or verified. Compilation establishes no 56-case pass result; the separately reported 18 boundary passes were not measured here.
