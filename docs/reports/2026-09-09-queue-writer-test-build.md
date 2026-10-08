# Queue writer test compilation — 2026-09-09

**Result: `npm run build` exited 0 with no TypeScript diagnostics.** The current configuration emitted `dist/tests/dispatch/workflow-task-writer.test.js`, its source map and declaration. This is compilation evidence only; test discovery and execution were NOT RUN.

## Checkout and currentness

- Worker: `qb1136-builder`; task #1136; branch `build/1136-queue-writer-tests`.
- Build source HEAD: `d73f112d85aee88d1d6925230ce3f3a59f052dc9`.
- Current main HEAD, remeasured after compilation: `f509ed8db835a667e007570900132f63fabe2bb6`.
- `git diff --name-status HEAD f509ed8db835a667e007570900132f63fabe2bb6 -- src package.json package-lock.json tsconfig.json scripts/run-tests.mjs`: `empty`.
- Live main tracked diff against its HEAD for the same paths: `empty`.
- Retained test Git blob, independently measured before and after build: `3b2ee8fc5cefd7ca078b1d03456b3b37cf5b378b`; matches dispatch `3b2ee8fc5cefd7ca078b1d03456b3b37cf5b378b`.
- Initial and post-build tracked checkout were clean. Source, tests, package, lock, config and runner were not changed. The report commit is the commit containing this file; its exact SHA is delivered in the REPORT inject (avoids a self-referential commit hash).

## Command and environment

- Cwd: `/Users/duckyoungkim/.aigentry/worktrees/qb1136`.
- Build start UTC: `2026-09-09T14:00:25Z`.
- Actual argv: `["npm", "run", "build"]`; package script `tsc -p .`.
- One compiler invocation, exit 0. Python subprocess wrapper imposed a 60-second timeout; it did not fire. Build process completed before reporting.
- Node: `v20.20.0`; npm: `10.8.2`; TypeScript: `5.9.3` (version commands each exited 0).
- Node and npm executables: `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/node` and `/Users/duckyoungkim/.nvm/versions/node/v20.20.0/bin/npm`.
- Resolved compiler: `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules/typescript/bin/tsc`.
- `node_modules` was initially absent. Created the permitted ignored symlink to `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules`. `dist/` was initially absent; generated output is local and ignored. No writes to shared dependencies or main dist were requested.
- Read tsconfig: includes `src/**/*.ts` and `tests/**/*.ts`, root `.`, output `dist`, declaration and source map enabled. No options changed.

Exact combined build stdout/stderr (no diagnostics):

```text

> @dmsdc-ai/aigentry-orchestrator@0.2.0 build
> tsc -p .
```

## Dependency provenance

Initial metadata capture stopped on missing @dmsdc-ai/aigentry-telepty/package.json before build invocation. Retried metadata capture with missing package recorded; no dependency installation or repair.

| Package | Installed version | Resolved package metadata | SHA-256 |
|---|---|---|---|
| typescript | 5.9.3 | `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules/typescript/package.json` | 822ef7ca6452205657b6288b066481ecf508bfbf43455d715cf7d3ec457561e6 |
| @types/node | 20.19.41 | `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules/@types/node/package.json` | e6b573ab97177c4d783cc85bd1c369d374ef242f461e8c0264c58327ef1653ca |
| @dmsdc-ai/aigentry-logger | 0.2.0 | `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules/@dmsdc-ai/aigentry-logger/package.json` | 406774187c0c5fd4505092974dd2b7f9a8ce067a29320d550843f13fc33750c1 |
| @dmsdc-ai/aigentry-ssot | 1.0.0 | `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules/@dmsdc-ai/aigentry-ssot/package.json` | 47c378536e52ce3895b802602d28f990145a3ca532bcee68d7b5d325cdcd730c |
| @dmsdc-ai/aigentry-telepty | MISSING | `/Users/duckyoungkim/.aigentry/worktrees/qb1136/node_modules/@dmsdc-ai/aigentry-telepty/package.json` | n/a |

`npm ls --all --json --offline` exited 1 (`ELSPROBLEMS`). It reported missing declared `@dmsdc-ai/aigentry-telepty@^0.8.0`, extraneous packages and nested missing dependencies, including package development dependencies. These are dependency inventory diagnostics, separate from the compiler exit 0; no dependency repair was attempted. Full combined inventory output is retained locally in ignored `dist/.qb1136-build/evidence.json`. This shared tree is usable for this compilation but is not evidence of npm package closure.

## Source and emitted hashes

| File | SHA-256 |
|---|---|
| `tests/dispatch/workflow-task-writer.test.ts` | `1550394df319c15a7243e4d9e265fc8c0c0e35deb6cefb60e6a2d3f45bc2309b` |
| `package.json` | `2b56fef3f0924d72bdef42c7e50a4a122ade11173bb979dfc087d63fe9d3465a` |
| `package-lock.json` | `3a5943e964919ab28eea9452fb68239341d0640ee1b8e57f0683aa62accef788` |
| `tsconfig.json` | `7f867214418ae3ed617dba351c2d4c99064b8e7afd3b9a0d34ece8cc8a94bc97` |
| `scripts/run-tests.mjs` | `5a689e7320ad70c2357f99e4527ce4fade966964f2af2c9218471a08bd35f31b` |
| `dist/tests/dispatch/workflow-task-writer.test.d.ts` | `8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881` |
| `dist/tests/dispatch/workflow-task-writer.test.js` | `fa764b9e81af227d8c2bbfe18c2bb2e2b674de29bfed8228c989b5c7dd27b990` |
| `dist/tests/dispatch/workflow-task-writer.test.js.map` | `84c2605764cbd51586861986f81e3c8666967e09e1879ce0694a45d05746bff1` |

All emitted files: 330; sorted SHA-256 manifest retained locally at `dist/.qb1136-build/emitted-sha256.txt`, manifest SHA-256 `d2daaf1bea7aa5ffb897ce939017ff4a036303a60fcbac60914a5d5d4c24f34f`. Individual owned-test artifact hashes above remain in this committed report.

## Limits and handoff

- `bin/tq-write.py` is absent, rechecked from the filesystem. Expected future-feature red remains; no runtime outcome is claimed.
- NOT RUN: npm test, node --test, scripts/run-tests.mjs, compiled-test imports, test discovery, owned acceptance execution, all-suite execution, application or production loop.
- NOT VERIFIED: fresh install, package-lock reproducibility, npm package closure, runtime behavior, lost-update reproduction or lock-preservation behavior. No install/ci, network repair, publish, push or restart performed.
- Prior tester diagnostics and zero-issue Snyk scan are dispatch-attributed evidence only, not independently rerun here. Snyk N/A for this report-only phase; no first-party source changes.
- Next phase requires the orchestrator to arrange tester execution. Parent task remains incomplete. REPORT and HOLD are sent after the report commit.
