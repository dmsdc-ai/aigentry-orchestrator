# SPEC — ADR-MF #10 Comprehensive cross-cutting test suite

- Status: DRAFT (E-coder-mf10-tests, 2026-05-12)
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §6 task #10
- Depends on (all landed):
  - `d06e9cb` — #3 SessionContext + G1–G6 (#99)
  - `c24647b` — #14 persistence primitives (canonical-bytes, atomic-write, index-lock, crash-recovery)
  - `3a13fb5` — #8 Permission Manager / P1 (#103)
  - `28f94b0` — #4 deterministic resolver + VirtualFS + project_id (#114)
  - `feda4b9` — #5 SessionContext persistence (#115)
  - `426f3a9` — #13 per-CLI boot adapter (#104)
- Successor: ADR §6 task #11 (hard-fail flip, #120) — this suite + its coverage report is the gate
- Constitution: Article 1 경량 (this SPEC ≤ 300 LOC; tests total ≤ 500 LOC; fixtures ≤ 200 LOC); Article 17 무의존 (`node:test` + `node:assert/strict` only; no jest/vitest); Rule 29 외과적 변경 (NEW files only; zero edits to `src/`; `package.json` Δ ≤ 3 lines); Article 2 크로스 (macOS + Linux; Windows-specific paths skipped)

---

## 1. Why this suite exists

Per-module unit tests (120/120 today) cover each ADR-MF brick in isolation:

| Module | File | Tests |
|---|---|---|
| #99 G1–G6 | `tests/session/validate-spawn.test.ts` | 14 |
| #103 P1 | `tests/session/permission-manager.test.ts` | 11 |
| #114 resolver | `tests/session/resolve-instructions.test.ts` | 12 |
| #115 persistContext | `tests/session/persist-context.test.ts` | 13 |
| #14 persistence | `tests/session/persistence/*.test.ts` | 28 |
| #104 boot-adapter | `tests/session/boot-adapter/*.test.ts` | 19 |
| #9 warn-mode | `tests/session/warn-mode.test.ts` | 12 |

These verify per-brick contracts. None verify that the bricks **compose** correctly across the spawn pipeline. Task #10 closes that gap so #11 (hard-fail flip) can read a single composition-level readiness signal instead of inferring it from 120 brick-level greens.

The suite tests **emergent invariants** — role propagation through depth, anti-leak across the resolver+boot-adapter seam, digest reproducibility across runs, cross-adapter conformance to one BootCommand contract, persistence under concurrency, warn-mode telemetry end-to-end, and cycle detection at scale.

---

## 2. Naming discipline — composition layer, not new modules

This suite **invokes existing surfaces only**. No new exports added to `src/`. No edits to `src/` (Rule 29 외과적). All "fixtures" are pure TS helpers under `tests/fixtures/adr-mf/` — they call the same public APIs that the suite verifies.

The seven scenario files map 1:1 to the seven Dispatch §A categories.

---

## 3. Test categories (Dispatch §A → file map)

All files live under `tests/session/` and run via `node --test dist/tests/**/*.test.js` (existing npm test target).

### 3.1 `deep-hierarchy.test.ts` — parent→child→grandchild role preservation

Validates that a three-link spawn chain preserves role-discipline invariants end-to-end.

**Scenarios** (5):

1. **D1 chain coverage** — orchestrator → coder → coder. Each link calls `validateSpawn` with the previous level's `SessionContext` as `opts.parent`. All three return `{ ok: true }`. Verifies G1/G3 do not require role overrides for same-role transitions (coder→coder).
2. **D2 capability subset across depth** — grandparent caps `[spawn_l1, read_fs, write_fs, bash]`, parent (coder) inherits `[read_fs, write_fs, bash]`, grandchild (coder) requests `[read_fs, bash]` → P1 ok. Then grandchild requests `[write_fs, network]` → `ERR_CAPABILITY_EXPANSION` because `network` was already dropped at link 1.
3. **D3 cwd mutation mid-chain does not mutate role** — parent.cwd = `/repo`, child spawned with cwd = `/repo/sub`, grandchild with cwd = `/tmp/elsewhere`. Role chain stays `orchestrator → coder → coder` regardless. Asserts no automatic role-derivation from cwd anywhere in the validator. (Anchors ADR §3.2 cwd-role decoupling.)
4. **D4 cycle A→B→A** — provide `lookup_parent` that returns A as B's parent and B as A's parent. `validateSpawn` with `proposed_session_id = "A"` returns `ERR_CYCLE_DETECTED`.
5. **D5 spawn_chain monotonic** — build three `SessionContext`s manually (since the spawn pipeline that materialises `spawn_chain` lives in #15); assert that the grandchild's `spawn_chain` is a prefix-extension of the child's, and `depth` is `parent.depth + 1` at each link.

### 3.2 `no-implicit-inheritance.test.ts` — orchestrator children get no leak

Validates the ADR §4.5 anti-leak invariant: a child of an orchestrator gets ONLY its own role/capabilities + the resolver's layered instructions, never the orchestrator's dispatch protocol text.

**Scenarios** (4):

1. **N1 capability narrowing** — parent role=orchestrator (full caps), child role=coder, no `requested_permissions`. `checkSpawnPermissions` returns the coder role-default intersected with parent's caps. Assert `spawn_l1` absent from the result (coder cannot spawn L1).
2. **N2 effective_prompt anti-leak** — resolver run with role=coder against a VirtualFS where `roles/orchestrator.md` contains a known marker string `ORCH_DISPATCH_PROTOCOL_MARKER`. Assert `resolved.effective_prompt` does NOT contain the marker (resolver reads `roles/coder.md`, not `roles/orchestrator.md`).
3. **N3 digest divergence** — same task body, same cwd, only role differs (coder vs orchestrator). Resolver yields different `effective_prompt_digest`. Confirms #114's role layer is digest-bound.
4. **N4 G2 implicit-clone rejection** — parent role=orchestrator, child role=orchestrator, no `parent_role_override` → `ERR_ORCHESTRATOR_CLONE`. With `parent_role_override=true` + non-empty `role_override_reason` → ok.

### 3.3 `digest-reproducibility.test.ts` — canonical-bytes determinism

Validates `effective_prompt_digest` and `canonical-bytes(SessionContext).sha256` are deterministic across replays and input encodings.

**Scenarios** (5):

1. **R1 same inputs → same digest** — call `resolveInstructions(ctx, fs)` twice with identical inputs; both digests equal byte-for-byte.
2. **R2 CRLF / LF / NFD normalization** — feed `roles/coder.md` as CRLF, then as LF, then as NFD-decomposed Unicode. All three runs produce the same `effective_prompt_digest`. (Exercises `canonicalBytes` in `normalizeLayer`.)
3. **R3 BOM stripping** — same file with and without a leading `\uFEFF`. Same digest.
4. **R4 SessionContext key-order independence** — construct two `SessionContext` objects with the same fields in different declaration order; `canonicalBytes` → `sha256Hex` equal.
5. **R5 layer ordering forced** — resolver collects sources out of order (forced by feeding the VirtualFS map in reversed order). Output digest matches the canonical-ordered run. Anchors `collectSources` sort.

### 3.4 `boot-adapter-conformance.test.ts` — three-CLI contract

Validates all three adapters (claude/codex/gemini) satisfy the same `BootCommand` + `verifyBootSelfTest` contract.

**Scenarios** (5; one parametric matrix that expands to 3×N where it makes sense):

1. **B1 BootCommand surface** — for each `cli ∈ {claude, codex, gemini}`: `getBootAdapter(cli).buildBootCommand(ctx, resolved, opts)` returns a frozen object with `argv[0] === cli`, `expected_digest === resolved.effective_prompt_digest`, `code_scope_cwd === ctx.cwd`, `prompt_file` written into `staging_dir`, and `cwd` either equal to `ctx.cwd` (claude `--bare`) or a scratch path inside `staging_dir/control` (codex+gemini).
2. **B2 self-test happy path** — for each cli, `runSelfTest` with a `mockSpawner` that returns `READY <digest>` → `errors.length === 0`, `suppression_verified === true`.
3. **B3 digest-mismatch trip** — mockSpawner returns `READY deadbeef…` (wrong digest) → exactly one error `BOOT_DIGEST_MISMATCH`.
4. **B4 leak-marker detection** — mockSpawner stdout contains `ORCH_DISPATCH_PROTOCOL_MARKER`; pass `leak_markers: ["ORCH_DISPATCH_PROTOCOL_MARKER"]` → `BOOT_LEAK_DETECTED`.
5. **B5 unsupported CLI** — `getBootAdapter("opencode")` throws `BootAdapterError("UNSUPPORTED_CLI")`. Confirms the registry's closed-set guarantee.

### 3.5 `persistence-protocol.test.ts` — end-to-end persist→load cycle

Validates the #5+#14 stack composes: a `SessionContext` from `validateSpawn`+`resolveInstructions` survives `persistContext` → `loadContext` with byte-identical digest and consistent state under concurrency.

**Scenarios** (5):

1. **P1 spawn → persist → re-read** — build `SessionContext` whose `effective_prompt_digest` comes from a real `resolveInstructions(ctx, memoryFs(...))`. Persist. Re-load. `deepEqual` and `sha256` match. (Crosses the #114→#115 seam.)
2. **P2 same-id concurrent race** — `Promise.allSettled` of 4 concurrent `persistContext` calls with same id, byte-identical context. Exactly one wins via `withIndexLock`; others observe `alreadyPersisted: true` OR re-acquire the lock and find the existing snapshot. Final state: 1 index entry, 1 context.json, no `*.tmp.*` residue.
3. **P3 crash recovery** — pre-place 3 `context.json.tmp.<sid>.<pid>` stubs across two session dirs. `recoverCrashedWrites` sweeps all 3, appends one NDJSON line to `.recovery.log`. Subsequent persist of those sids works cleanly.
4. **P4 index ↔ snapshot consistency** — persist 5 sessions, hand-corrupt one `context.json` byte. `loadContext` for that id throws `ERR_DIGEST_MISMATCH`; the other 4 still load.
5. **P5 digest stability across persist** — `persistContext` followed by `loadContext` yields a `SessionContext` whose `sha256Hex(canonicalBytes(ctx))` matches the persist-time `result.sha256`. Closes the round-trip canonical-bytes loop.

### 3.6 `warn-mode-telemetry.test.ts` — composition with #9

Validates that warn-mode degraded spawns interact correctly with the boot-adapter and resolver — specifically, that a degraded role (logger) flows into the downstream surfaces.

**Scenarios** (4):

1. **W1 degraded role honored downstream** — `enforceSpawn(req-with-bad-cwd, mode='warn')` returns `effective_role: logger, degraded: true`. Then build a `SessionContext` with that role and call `resolveInstructions`. Result reads `roles/logger.md`, NOT `roles/coder.md`. Digest matches the logger-layer canonical bytes.
2. **W2 telemetry event present + schema-valid** — same call, capture emitted events via injected `emit` sink. Expect exactly `[spawn_rejected, spawn_degraded]` with `ctx_digest` propagated from `opts.parent.effective_prompt_digest`.
3. **W3 mode transition recorded across two calls** — warn→hard-fail emits one `mode_changed` event with `reason: 'warn→hard-fail'`. Mirrors the existing single-module test #8 but invokes the full chain (resolver+enforceSpawn) so we know the transition still fires after `_lastObservedMode` survives a real session.
4. **W4 aggregator integration** — write the captured events via `emit` to a temp telemetry root, then invoke `bin/spawn-telemetry-report.sh --root TMP --out SUMMARY.md --days 1`. Assert SUMMARY.md contains both the reject and degrade counts. (This is a thinner re-run of the per-module #12 test but specifically with events generated by the **composed** stack, not hand-rolled fixtures.)

### 3.7 `cycle-detection.test.ts` — robustness + perf bound

**Scenarios** (4):

1. **C1 direct cycle** — `lookup_parent("B") = A; lookup_parent("A") = B`; `validateSpawn({ parent_session_id: "B", proposed_session_id: "A", ... })` → `ERR_CYCLE_DETECTED`.
2. **C2 spawn_chain prefix cycle** — `opts.parent.spawn_chain = ["X", "Y", "X"]` → `ERR_CYCLE_DETECTED` (duplicate ancestor branch in `g6Cycle`).
3. **C3 100-deep chain detection <100ms** — build a `lookup_parent` that walks 100 ancestors; with `proposed_session_id` matching ancestor at index 99, `validateSpawn` returns `ERR_CYCLE_DETECTED` and the test asserts wall-clock <100ms (`process.hrtime.bigint()` diff). Hardware-portable; loose bound (CI margins).
4. **C4 no-cycle baseline** — same 100-deep chain with `proposed_session_id` absent from ancestors → `ok: true`, same perf bound. Confirms the perf path is not skipped by an early return.

**Total scenarios:** 5+4+5+5+5+4+4 = **32**.

---

## 4. Fixtures (`tests/fixtures/adr-mf/`)

Three small TS helpers — pure, no I/O, no assertions of their own. Each is `<= 70 LOC`; total fixture budget ≤ 200 LOC.

### 4.1 `context-factory.ts`

```ts
export function makeCtx(over?: Partial<SessionContext>): SessionContext
export function makeChildOf(parent: SessionContext, over?: Partial<SessionContext>): SessionContext
export function makeChain(roles: Role[], cwds?: string[]): SessionContext[]   // ordered ancestor[0] → deepest
```

Returns frozen `SessionContext` values with `created_at: '2026-05-12T00:00:00+00:00'`, monotonically increasing `depth`, and `spawn_chain` derived from the chain. Resolves the boilerplate that `tests/session/boot-adapter/_fixtures.ts:makeCtx` already does for one level — generalises to N levels.

### 4.2 `memory-fs-builder.ts`

```ts
export interface InstructionLayers {
  common?: string;
  project?: { id: string; body: string };
  roles?: Partial<Record<Role, string>>;
  tasks?: Record<string, string>;
}
export function buildLayeredFs(layers: InstructionLayers, root?: string): VirtualFS
```

Wraps `memoryFs` from `src/session/virtual-fs.ts` with the layered path convention from `resolve-instructions.ts:collectSources` (`<root>/common.md`, `<root>/projects/<id>.md`, `<root>/roles/<role>.md`). Eliminates per-test path-joining and lets scenarios declare intent (`{ roles: { coder: "...", orchestrator: "..." } }`).

### 4.3 `mock-spawner-presets.ts`

```ts
export function readyForDigest(version?: string): MockScript          // emits READY <digest>
export function leakingSpawner(marker: string, version?: string): MockScript
export function digestMismatchSpawner(badDigest: string): MockScript
export function unsupportedFeatureSpawner(): MockScript               // probeFeature → false
```

Re-uses the existing `mockSpawner` from `boot-adapter/spawner.ts`. Same idea as `tests/session/boot-adapter/_fixtures.ts:readyScript` but covers the three failure modes the conformance suite exercises.

---

## 5. Test runner integration (`package.json` Δ ≤ 3 lines)

Current scripts:

```json
"build": "tsc -p .",
"test": "tsc -p . && node --test dist/tests"
```

After (additive only):

```json
"test:adr-mf": "tsc -p . && node --test dist/tests/session/deep-hierarchy.test.js dist/tests/session/no-implicit-inheritance.test.js dist/tests/session/digest-reproducibility.test.js dist/tests/session/boot-adapter-conformance.test.js dist/tests/session/persistence-protocol.test.js dist/tests/session/warn-mode-telemetry.test.js dist/tests/session/cycle-detection.test.js"
```

One line. `npm test` continues to run everything (the new files are picked up by `dist/tests/**/*.test.js` already). Δ = 1 script entry + trailing comma on previous line = 2 lines net.

**CI verification:** deferred (Dispatch §C "defer hook setup"). After this lands, `bin/` could grow a `pre-commit` hook calling `npm test`, but that's out of scope for #10.

---

## 6. Coverage report (`§D`)

After implementation:

```bash
node --test --experimental-test-coverage \
  --test-coverage-include='src/session/**' \
  --test-reporter=lcov --test-reporter-destination=coverage.lcov \
  dist/tests/**/*.test.js
```

Targets:
- **Lines ≥ 85%** for `src/session/**`
- **Branches ≥ 80%** for `src/session/**`

Already-covered files (per-module unit tests) should keep their existing coverage; the new suite is **additive** and is expected to push coverage of cross-cutting branches in `validate-spawn.ts:g6Cycle`, `permission-manager.ts:propagateSubset`, `resolve-instructions.ts:collectSources`, and `boot-adapter/common.ts:makeAdapter` higher than the per-module tests alone.

Uncovered branches → reported in the implementation REPORT as the #11 hard-fail readiness audit input.

---

## 7. Out of scope (deferred to other tasks)

- **Real spawn execution**: no real `claude`/`codex`/`gemini` processes spawned. `mockSpawner` only. Real-runtime self-test is Q-OPEN-OQ2 (deferred per `boot-adapter/types.ts:54` comment).
- **#15 spawn-pipeline integration**: this suite tests bricks in composition, but does not test the full spawn entrypoint (which doesn't exist yet — `validateSpawn`+`enforceSpawn` is called from #15's caller).
- **CI hook setup**: explicitly deferred per Dispatch §C.
- **Windows path tests**: skipped per Dispatch constraints + ADR §4.8.2 Phase 2 note. Tests use POSIX paths only.
- **Per-MCP / per-glob capability tests**: Q-OPEN-2-FOLLOWUP (ADR §7.2), out of scope for #8 so out of scope here.

---

## 8. Open questions for orchestrator

1. **OQ1** — Coverage tooling. Node ≥ 20 supports `--experimental-test-coverage` + lcov, which lets us avoid adding `c8`/`nyc` (Article 17 무의존). Acceptable, or do we want a non-experimental tool? Default: stick with built-in.
2. **OQ2** — Perf bound on C3 (100-deep cycle <100ms). CI hardware varies; we propose a generous 250ms ceiling instead and document the design target as <100ms in a code comment. Default: 250ms.
3. **OQ3** — Coverage gate enforcement. `npm test` only reports coverage today; ADR §6 #10 doesn't say it must FAIL on threshold miss. Default: report-only; #11 decides gate semantics.
4. **OQ4** — Should `tests/fixtures/adr-mf/context-factory.ts:makeChain` accept role-override metadata? Three-link orchestrator→coder→coder doesn't need it for the scoped scenarios; we propose adding it only if a scenario needs it (YAGNI). Default: omit for now.

---

## 9. Acceptance criteria

- [ ] `npm test` reports `tests 120 + 32 = 152, pass 152, fail 0` (or close; small drift acceptable if a scenario splits).
- [ ] `npm run test:adr-mf` runs the 7 new files in isolation, green.
- [ ] Zero edits to `src/`. `git diff src/` empty after impl.
- [ ] `package.json` Δ ≤ 3 lines net.
- [ ] Coverage report under `src/session/**`: lines ≥ 85%, branches ≥ 80%.
- [ ] Existing 120/120 tests untouched and still pass.
- [ ] Tests run on macOS + Linux (Node 20). Windows-specific paths skipped (`if (process.platform === 'win32') t.skip(...)`).
- [ ] LOC budget: tests ≤ 500 total + fixtures ≤ 200 + this SPEC ≤ 300.
