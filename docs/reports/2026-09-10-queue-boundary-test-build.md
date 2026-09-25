# Queue boundary test compilation — 2026-09-10

Actual `npm run build` passed: exit 0, first and only attempt, 1074.23 ms, no compiler diagnostics. Latest tests were NOT RUN. Parent task #1136 remains incomplete; HOLD for tester execution.

Source commit: `c75d360bde57d1f1f5859712931c5b4cb577cb8b`. Branch: `build/1136-queue-boundary-tests`. Checkout: `/Users/duckyoungkim/.aigentry/worktrees/qb1136b`. Initial tracked tree was clean; source pins matched before and after compilation. This report is the sole tracked change; its containing commit is the report commit.

Current local main sampled at report creation: `537edb781be9229395a97db3ffd29eae901826f0` (no fetch). Initial main was `4c0e767e14641030715626359a4bdd6e9ad86af4`; verification later saw `537edb781be9229395a97db3ffd29eae901826f0`. Main moved independently; no main writes were performed. Comparison against the report sample:

```
A	bin/tq-write.py
A	tests/dispatch/workflow-task-writer.test.ts
```

The helper and test are absent from this sampled main. Package, lock, config and runner are identical between sampled main and source HEAD. No whole-repository parity claim.

## Actual build

```json
{
  "argv": [
    "npm",
    "run",
    "build"
  ],
  "cwd": "/Users/duckyoungkim/.aigentry/worktrees/qb1136b",
  "started_utc": "2026-09-10T10:59:44.442653+00:00",
  "elapsed_ms": 1074.23,
  "exit": 0,
  "stdout": "\n> @dmsdc-ai/aigentry-orchestrator@0.2.0 build\n> tsc -p .\n\n",
  "stderr": ""
}
```

Executable resolution: npm `/opt/homebrew/bin/npm` 11.6.2; Node `/opt/homebrew/bin/node` v25.2.1; TypeScript 5.9.3, measured with `node node_modules/typescript/bin/tsc --version`. Build script is exactly `tsc -p .`; tsconfig includes `src/**/*.ts` and `tests/**/*.ts`, excludes node_modules/dist, emits ES2022 modules with declarations and source maps into local `dist`. Build subprocess completed and was joined; outer subprocess timeout was 55 seconds.

## Dependency provenance and limits

`node_modules` was absent. Created the authorized ignored symlink to `/Users/duckyoungkim/projects/aigentry-orchestrator/node_modules`; dependencies were used read-only. Local dist was absent before build and is ignored. No install, ci, upgrade, dependency repair, declaration fabrication or network action.

`npm ls --depth=0 --offline` actually exited 1 / ELSPROBLEMS: missing declared `@dmsdc-ai/aigentry-telepty@^0.8.0`; extraneous `ajv@8.20.0`, `fast-deep-equal@3.1.3`, `fast-uri@3.1.2`, `json-schema-traverse@1.0.0`, `require-from-string@2.0.2`, `undici-types@6.21.0`. Installed inventory also reports logger 0.2.0, ssot 1.0.0, @types/node 20.19.41, TypeScript 5.9.3. Successful compilation does not establish dependency/package closure or clean-install reproducibility.

## Source hashes

| File | Git blob at source HEAD | SHA-256 |
| --- | --- | --- |
| `tests/dispatch/workflow-task-writer.test.ts` | `46bc236a774ef8c458afd609a5994c01726eefe7` | `be3afa7c4eae51f0f4e0afc509c112fa984c3f741cb90d18a9e1218f5d1adfd2` |
| `bin/tq-write.py` | `c6654295b5614e18cd3ab4b70e18e6314e48b03f` | `7e6e6dd1ebe210d1a772e382234be4d31d4939e62db5512b3a70a4304a4de417` |
| `package.json` | `364f750650347d2cec1e29ca2672b6aac5f68319` | `2b56fef3f0924d72bdef42c7e50a4a122ade11173bb979dfc087d63fe9d3465a` |
| `package-lock.json` | `af13988b3d5615af52304971bd944a5a76ead620` | `3a5943e964919ab28eea9452fb68239341d0640ee1b8e57f0683aa62accef788` |
| `tsconfig.json` | `b5fc061564acc0cf0f10b0f3023128763995c208` | `7f867214418ae3ed617dba351c2d4c99064b8e7afd3b9a0d34ece8cc8a94bc97` |
| `scripts/run-tests.mjs` | `f524e578de667cc0cbe21db4af9bd265279b7dec` | `5a689e7320ad70c2357f99e4527ce4fade966964f2af2c9218471a08bd35f31b` |

## Emitted artifacts

| File | SHA-256 |
| --- | --- |
| `dist/tests/dispatch/workflow-task-writer.test.js` | `d3ed307c55796d45fb28052ae40df152b6f78188214be46b0dd3b22d60e0029f` |
| `dist/tests/dispatch/workflow-task-writer.test.js.map` | `6a989e6e4d9ef26c28379b97629aa463c2596a547ae6f6c8fd23ad20f4a60079` |
| `dist/tests/dispatch/workflow-task-writer.test.d.ts` | `8e609bb71c20b858c77f0e9f90bb1319db8477b13f9f965f1a1e18524bf50881` |

Verified by reading generated files, without imports: emitted JS includes note, numeric-ID, fsync/replace and encoding boundary cases (including MALFORMED_QUEUE assertions); map version 3 names `workflow-task-writer.test.js` and source `../../../tests/dispatch/workflow-task-writer.test.ts`, resolving to the exact pinned checkout source; declaration is `export {};`. Historical source comments saying NOT COMPILED remain verbatim and describe earlier authorship, not this build.

## Explicit non-verification and inherited evidence

No test discovery/execution, node --test, npm test, runner execution, test import, Python helper execution, application execution, runtime acceptance, source fix, package/release check or live activation. No source/tests/package/lock/config/runner edits. All build subprocesses finished.

Dispatch-attributed prior evidence only: older compiled suite 29/29 passed in 12377.02 ms on Node 20.20.0; 27 separate direct Python diagnostics yielded 22 pass / 5 fail (initial 2177.58 ms, final 2810.72 ms). Those runs do not verify this newly emitted suite. Known helper failures remain: present note:null accepted; two large numeric IDs mismatch JS text; unrelated 1e400 publishes invalid JSON Infinity; surrogate note throws and leaks its own temp. Stored invalid/unrepresentable encoding is expected to refuse with 4 MALFORMED_QUEUE, unchanged and without own-temp leak.

Snyk: N/A for this report-only builder; generated output is from unchanged sources. Tester-reported owned TypeScript scan was zero issues; Python helper 2 LOW findings remain unresolved. No new scan or whole-repository/security acceptance claim.
