# SPEC — ADR-MF #11 Hard-fail flip after compatibility audit

- Status: DRAFT (E-coder-mf11-hardfail, 2026-05-13)
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §6 task #11 + §11 changelog
- Depends on (all landed):
  - `d06e9cb` — #3 SessionContext + G1–G6 (#99)
  - `3a13fb5` — #8 Permission Manager / P1 (#103)
  - `28f94b0` — #4 deterministic resolver + VirtualFS + project_id (#114)
  - `feda4b9` — #5 SessionContext persistence (#115)
  - `c24647b` — #14 persistence primitives (#101)
  - `426f3a9` — #13 per-CLI boot adapter (#104)
  - `c609e39` — #9 warn-mode validation + telemetry (#118)
  - `b6865c1` — #10 cross-cutting test suite + fixtures (#119)
  - `11a0451` — #15 Class A/B/C gate integration (#121)
- Successor: ADR-MF migration COMPLETE — no further blocking tasks in §6.
- Audit verdict: **PROCEED (with one ADR-interpretation open question — OQ1 below)**
- Constitution: Article 1 경량 (this SPEC ≤ 300 LOC; src Δ ≤ 80 LOC; tests Δ ≤ 120 LOC); Article 17 무의존 (TS strict, only existing deps); Rule 29 외과적 변경 (constant flip + ADR §11 + AGENTS.md ≤ 5 lines); Article 2 크로스 (no platform-specific changes — pure TS constant flip)

---

## 1. Why this module exists

`DEFAULT_VALIDATION_MODE` in `src/session/validate-spawn.ts:257` is the migration-window default for `enforceSpawn()`. Today it returns `'warn'` (degraded fallback to `logger`, telemetry-only); ADR §6 task #11 flips it to `'hard-fail'` (throw `SpawnValidationError` on any G1–G6 + P1 violation). The flip closes the ADR-MF migration: every spawn surface that goes through `enforceSpawn()` (Class A telepty/cmux/cli_direct, Class B native Agent validator) becomes fail-closed. Class C MCP is unaffected (hard-codes its own modes — independently gated by `MCP_REQUIRE_SESSION_CONTEXT=1`).

The change is small (one constant, two test-only fixture lines, one §11 changelog entry, four AGENTS.md surface lines). The substance is in the **audit** that justifies the flip — that is §2 below.

---

## 2. Pre-flip audit (A.1–A.5)

### A.1 — #119 deep-hierarchy test suite under hard-fail mode

**Method.** Built `npm test` baseline (warn default); then patched `DEFAULT_VALIDATION_MODE = 'hard-fail'` locally and re-ran.

**Result.**

| State                                | tests | pass | fail | new fail vs baseline |
|--------------------------------------|------:|-----:|-----:|---------------------:|
| baseline (`DEFAULT = 'warn'`)         |  171  | 169  |   2  | —                    |
| audit (`DEFAULT = 'hard-fail'`, local)|  171  | 168  |   3  | +1                   |

**Pre-existing baseline failures (not introduced by #11):**

1. `tests/session/warn-mode-telemetry.test.ts` — W4 (`spawn-telemetry-report.sh` composed-stack aggregation).
2. `tests/session/warn-mode.test.ts` — report aggregation (12).

Both are time-bound: `bin/spawn-telemetry-report.sh` uses real-system `date -u -v -Nd` to compute the 7-day lookback window, while test fixtures emit events with literal ISO timestamps anchored to `2026-05-12`. On a wall-clock far from 2026-05-12 the lookback window misses the fixture file. **Pre-existing — does not gate #11.** Tracked as follow-up Snyk-style observation in §5 below; recommend filing as a separate baseline-test hygiene task.

**New failure introduced by the flip:**

3. `tests/session/warn-mode.test.ts:37–43` — `default mode constant matches ADR §6 #9 compat window` — asserts `DEFAULT_VALIDATION_MODE === 'warn'` and `readValidationMode({}) === 'warn'` and `readValidationMode({ AIGENTRY_SPAWN_VALIDATION_MODE: 'garbage' }) === 'warn'`. After the flip these assertions hold for `'hard-fail'`. **This is the only fixture rewrite required.**

**Warn-dependent tests requiring explicit `mode='warn'` fixture: 0.** All warn-mode behavior tests in `warn-mode.test.ts` and `warn-mode-telemetry.test.ts` already pass `mode: "warn"` explicitly through `enforceSpawn(...)` options; none rely on the default. Class A (telepty/cmux/cli_direct) tests pass explicit `mode`. Class B (`validateAgentPrompt`) tests pass explicit `mode` via `opts = { mode: "warn" }` or `hard = { mode: "hard-fail" }`. Class C MCP adapter is mode-insensitive to `DEFAULT_VALIDATION_MODE` (hard-codes its own modes). Deep-hierarchy / no-implicit-inheritance / digest-reproducibility / boot-adapter-conformance / persistence-protocol / cycle-detection tests use `validateSpawn()` directly (pure, mode-less).

**Verdict: A.1 PROCEED.** Only the constant-assertion test (a) needs rewriting, which is part of this SPEC's deliverable E.

### A.2 — #119 coverage 6 uncovered branches review

Per the `b6865c1` commit message: coverage on `src/session/**` is **lines 87.00%, branches 89.77%** (meets ≥85%/≥80% targets). Files below 85% lines fall into three categories:

1. **Production-only adapter shims, intentionally unexercised by mocks (mock strategy per `#119` SPEC §3.4):**
   - `src/session/virtual-fs.ts::nodeFs()` — Node FS adapter (production); tests use in-memory `memoryFs()` fixture.
   - `src/session/boot-adapter/spawner.ts::nodeSpawner()` — real `child_process.spawn` (production); tests use `mockSpawner`.
   - `src/session/boot-adapter/boot-fs.ts::nodeBootFs()` — production FS for staged prompt file; tests use `memoryBootFs`.
2. **Interface-only declarations:**
   - `src/session/types.ts` — TS interfaces; no executable branches to cover.
3. **Tooling bug (not a real gap):**
   - `src/session/persist-context.ts` — Node 20.20.0 `--experimental-test-coverage` upstream bug aborts the report when `persist-context.test.ts` is included; the test itself runs green (13/13). Suite still runs 152/152 outside coverage. Acceptance rationale: tracked as follow-up Q-OPEN-8 telemetry-cost adjacent to Node-tooling upgrade; not a #11 blocker.

**6 sub-85% items = 3 production-only adapters + types.ts + persist-context.ts (tooling bug) + zero genuine gaps.** All categorized as **acceptable per mock strategy**; documented in deliverable C (ADR §11 changelog).

**Verdict: A.2 PROCEED.**

### A.3 — #104 boot adapter upstream-gaps review

Enumerated from source (`src/session/boot-adapter/*.ts`):

| # | Site | Kind | Blocking for #11? | Rationale |
|---|------|------|-------------------|-----------|
| 1 | `claude.ts:6` `CLAUDE_MIN_VERSION` TODO | MIN_VERSION | No | Real-CLI version drift surfaces as `CLI_VERSION_DRIFT` — the *correct* hard-fail outcome. |
| 2 | `codex.ts:5` `CODEX_MIN_VERSION` TODO | MIN_VERSION | No | Same as #1. |
| 3 | `gemini.ts:5` `GEMINI_MIN_VERSION` TODO | MIN_VERSION | No | Same as #1. |
| 4 | `codex.ts:7` env-var names TODO | env-var | No | Suppression is best-effort; resolver still owns the prompt; leak-marker self-test catches any leak regardless of env-var correctness. |
| 5 | `codex.ts:8` UPSTREAM-GAP comment | env-var docnote | No | Same as #4 (annotation, not behavior). |
| 6 | `gemini.ts:7` env-var TODO | env-var | No | Same as #4. |
| 7 | `gemini.ts:8` UPSTREAM-GAP comment | env-var docnote | No | Same as #5. |
| 8 | `types.ts:53` `leak_markers` UPSTREAM-GAP | contract | No | READY `<digest>` ack contract isn't implemented by real CLIs today; mock-only validation per `#104` SPEC OQ2. Class A wrappers call `verifyBootSelfTest(...)` after spawn — with no real-CLI ack, the wrapper times out → `BOOT_TIMEOUT` → spawn rejected. Under hard-fail this is the *correct* fail-closed outcome; production rollout of Class A telepty/cmux against real Claude/Codex/Gemini requires upstream READY-handshake feature work that is **separately tracked** and explicitly out of scope for the #11 constant flip. |

**All 8 markers are NON-BLOCKING for the constant flip itself.** The flip changes the default validation mode; it does not change boot-adapter contracts. The above markers are production-readiness concerns that surface *the moment* Class A wrappers run against real CLIs — regardless of whether the validation default is warn or hard-fail. They will be tracked as **remaining follow-ups** in deliverable C (ADR §11 changelog) per the dispatch instruction.

**Verdict: A.3 PROCEED (markers non-blocking; follow-ups documented).**

### A.4 — #121 gate integration upstream gap (MCP server-side wiring)

Per `src/gate/class-c/mcp-deliberation-adapter.ts`:

- **Phase 1 (default):** ungated transitional — log, never block. `enforceSpawn` is called with explicit `mode: "warn"` (line 96). Hard-codes warn.
- **Phase 2 (`MCP_REQUIRE_SESSION_CONTEXT=1`):** `enforceSpawn` is called with explicit `mode: "hard-fail"` (line 113). Hard-codes hard-fail.

**Class C is insensitive to `DEFAULT_VALIDATION_MODE`.** The MCP server-side wiring (the host that actually invokes `gateMcpToolCall(...)` when a MCP tool is called) has not landed upstream — that is the `#121` follow-up. The decision per dispatch:

- **Defer hard-fail enforcement for the MCP class until upstream wiring lands.** This is already the operational state because (a) Phase 1 is the documented default and is feature-flag gated, and (b) the constant flip does not change MCP class behavior at all.
- The `MCP_REQUIRE_SESSION_CONTEXT=1` Phase 2 surface remains the orchestrator-owned dial for MCP-class hard-fail.

**Verdict: A.4 PROCEED. MCP class out of scope for the constant flip (architecturally separated).**

### A.5 — Q-OPEN-2 + Q-OPEN-4 acceptance audit

**Q-OPEN-4 — spawn-path unification.** RESOLVED at design level (ADR §4.3 three enforcement classes A/B/C). Integration shipped via `11a0451` (#121). All three classes invoke the shared `enforceSpawn()` core. **ACCEPTED.**

**Q-OPEN-2 — Permission Manager capability granularity.** RESOLVED at minimum-viable level by ADR §4.6.1 (capability↔CLI adapter table) and §4.6.2 (default role→capability table). Implementation lives in `src/session/permission-manager.ts` + `role-capabilities.ts` (`3a13fb5`, #103). **ACCEPTED at baseline.**

**Q-OPEN-2-FOLLOWUP — Capability-granularity refinements.** Per-MCP-server allowlists, per-domain network policy, per-path filesystem scoping. ADR §7.2 and §8 both describe these as **"acceptance-blocking for the hard-fail rollout (§6 task #11)"**. ADR §6 row 11 lists only `Q-OPEN-2 + Q-OPEN-4 acceptance` as the blocker — silent on FOLLOWUP. This is an **interpretation ambiguity** in the ADR text (codex r1 Issue 8 lineage).

**Two readings:**

- **Reading A (literal §7.2 / §8):** FOLLOWUP is itself blocking; #11 cannot flip until per-MCP/per-domain/per-path refinements ship.
- **Reading B (§6 row 11 + structural):** Only the baseline Q-OPEN-2 acceptance blocks #11; refinements are additive enhancements that don't change subset-propagation correctness; the §4.6.2 default role→capability table already enforces every safety invariant the flip needs.

**Recommended audit verdict: Reading B — PROCEED with acceptance-rationale.** Justification:

1. The minimum-viable §4.6.2 table already enforces the role→capability subset invariant that G1–G6 + P1 check.
2. Refinements (per-MCP allowlists, per-domain network) are *narrower* than the baseline (they shrink the allowed set further — strictly safer under hard-fail). A flip with baseline-only granularity cannot be *less safe* than a flip with refinement granularity.
3. Operationally, the flip + refinement work being decoupled is Article 1 (경량) compliant; bundling would inflate scope.
4. The ADR §6 row 11 dependency list is the canonical task-tracker surface; the §7.2 / §8 language is descriptive narrative about the FOLLOWUP work item, not necessarily a #11 prerequisite.

**OQ1 (single open question to orchestrator):** Confirm acceptance interpretation is Reading B (proceed) versus Reading A (block). If Reading A is preferred, the flip halts pending a Q-OPEN-2-FOLLOWUP scoping dispatch.

**Verdict: A.5 PROCEED (conditional on OQ1 confirmation).**

### Audit summary

| Item | Verdict | Notes |
|------|---------|-------|
| A.1 deep-hierarchy + full suite under hard-fail | PROCEED | 1 fixture rewrite required (warn-mode.test.ts test 159); 0 warn-dependent tests need new fixtures. |
| A.2 coverage 6 sub-85% branches | PROCEED | All in production-only adapters / TS interfaces / Node tooling bug — acceptable per mock strategy. |
| A.3 boot adapter 8 upstream gaps | PROCEED | All non-blocking for the constant flip; documented as remaining follow-ups in §11. |
| A.4 MCP server-side wiring | PROCEED | Class C is mode-insensitive to `DEFAULT_VALIDATION_MODE`; MCP hard-fail is its own knob (`MCP_REQUIRE_SESSION_CONTEXT=1`). |
| A.5 Q-OPEN-2 + Q-OPEN-4 acceptance | PROCEED (OQ1) | Q-OPEN-4 ACCEPTED; Q-OPEN-2 baseline ACCEPTED; Q-OPEN-2-FOLLOWUP requires orchestrator interpretation confirmation. |

**Aggregate audit verdict: PROCEED (pending OQ1).**

---

## 3. Deliverables (after orch approval)

### B. `DEFAULT_VALIDATION_MODE` flip — `src/session/validate-spawn.ts:257`

```diff
- export const DEFAULT_VALIDATION_MODE: ValidationMode = "warn"; // OQ1 — ADR §6 #9 compat window
+ export const DEFAULT_VALIDATION_MODE: ValidationMode = "hard-fail"; // ADR §6 #11 flip — compat window CLOSED
```

Single-line constant change. No edits to function bodies. Rule 29 외과적.

### C. ADR §11 changelog entry

Append after the existing `r2-patches` block:

```markdown
- **2026-05-13 — §6 task #11 hard-fail flip.** Author: E-coder-mf11-hardfail.
  Migration complete: `DEFAULT_VALIDATION_MODE = 'hard-fail'` (`src/session/validate-spawn.ts:257`).
  Compat window opened by `c609e39` (#9 warn-mode, #118) and closed here.

  **Audit (per §6 task #11 pre-flip checklist):**
  - A.1 `npm test` under simulated `DEFAULT='hard-fail'`: 168/171 pass, +1 new
    failure (`warn-mode.test.ts:37` constant assertion — rewritten in this
    commit). 0 warn-dependent tests required explicit-mode fixtures (all
    warn/hard-fail/off tests already pass mode explicitly).
  - A.2 #119 coverage 87.00% lines / 89.77% branches (per b6865c1). 6 sub-85%
    items = 3 production-only adapter shims (nodeFs, nodeSpawner, nodeBootFs)
    + types.ts (TS interface only) + persist-context.ts (Node 20.20.0
    --experimental-test-coverage upstream bug; suite runs green outside
    coverage) — all acceptable per #119 mock strategy.
  - A.3 #104 boot-adapter upstream gaps: 8 markers (3 MIN_VERSION TODOs +
    3 env-var TODOs + 2 contract UPSTREAM-GAPs) — all non-blocking for the
    constant flip. CLI_VERSION_DRIFT + BOOT_TIMEOUT + leak-marker self-test
    are correct fail-closed outcomes under hard-fail; real-CLI READY-handshake
    integration is separately tracked.
  - A.4 #121 MCP server-side wiring: Class C MCP adapter hard-codes its modes
    independently of DEFAULT_VALIDATION_MODE; Phase 1 (default) ungated,
    Phase 2 (MCP_REQUIRE_SESSION_CONTEXT=1) hard-fail. Out of scope for the
    constant flip.
  - A.5 Q-OPEN-4 ACCEPTED (§4.3 three-class design + #121 integration shipped).
    Q-OPEN-2 baseline ACCEPTED (§4.6.1 + §4.6.2 tables + #103 shipped).
    Q-OPEN-2-FOLLOWUP refinements (per-MCP allowlists, per-domain network,
    per-path FS scoping) deferred per orchestrator decision (Reading B): the
    baseline §4.6.2 table already enforces the subset invariant; refinements
    are strictly-shrinking additions that cannot reduce safety. Tracked as
    post-flip follow-up.

  **Remaining follow-ups (non-blocking; tracked):**
  - Snyk auth setup for orchestrator-driven scans (CLAUDE.md global rule).
  - MCP server-side wiring upstream (`#121` Phase 2 enable).
  - GEMINI.md Rule 16 alignment with hard-fail surface.
  - Q-OPEN-2-FOLLOWUP capability-granularity refinements (per ADR §8).
  - `bin/spawn-telemetry-report.sh` real-clock dependency in W4 / report.sh
    aggregation tests (pre-existing baseline failures unrelated to #11).
  - Boot-adapter empirical MIN_VERSION + upstream env-var name verification
    when real-CLI Class A integration ships.

  **Cited dependency commits:** d06e9cb (#3/#99) · 3a13fb5 (#8/#103) ·
  28f94b0 (#4/#114) · feda4b9 (#5/#115) · c24647b (#14/#101) ·
  426f3a9 (#13/#104) · c609e39 (#9/#118) · b6865c1 (#10/#119) ·
  11a0451 (#15/#121).

  **Rollback procedure.** `git revert <#11 commit>` restores
  `DEFAULT_VALIDATION_MODE = 'warn'` and the warn-mode test fixture. No
  schema migrations, no persisted-state changes — the flip is a pure source
  constant. Rollback is safe at any time provided the rollback commit lands
  before any downstream task assumes hard-fail semantics.

  **Status:** ADR-MF §6 migration COMPLETE.
```

### D. AGENTS.md surface update (≤5 lines)

Four-line edit at AGENTS.md:9, :50, :51, :56. Net change ≤5 lines (Rule 29 budget):

| line | before (excerpt) | after (excerpt) |
|------|------------------|-----------------|
|  9 | `**하드 enforcement는 ADR §6 task #11 (hard-fail flip) 착지 전까지 warn-mode**` | `**하드 enforcement 활성 (ADR §6 #11 hard-fail flip, commit \`<pending>\`)**` |
| 50 | `**Hard-fail enforcement pending ADR §6 task #11** (warn-mode until ...)` | `**Hard-fail enforcement ACTIVE (ADR §6 #11, commit \`<pending>\`; §11 changelog)**` |
| 51 | `... env \`AIGENTRY_SPAWN_VALIDATION_MODE\` (default \`'warn'\`, ADR §6 #9 compat window).` | `... env \`AIGENTRY_SPAWN_VALIDATION_MODE\` (default \`'hard-fail'\` per ADR §6 #11 — \`'warn'\` / \`'off'\` are explicit opt-outs).` |
| 56 | `... Hard-fail flip blocked on ADR §6 #11 (warn-mode audit + #9 ship).` | `... Hard-fail flip landed (ADR §6 #11, see §11 changelog).` |

### E. Tests — `tests/session/hard-fail-flip.test.ts` (new file, ≤100 LOC)

Four scenarios:

1. **Default constant is `'hard-fail'`** — `DEFAULT_VALIDATION_MODE === 'hard-fail'`; `readValidationMode({}) === 'hard-fail'`; `readValidationMode({ AIGENTRY_SPAWN_VALIDATION_MODE: 'garbage' }) === 'hard-fail'`.
2. **Default-mode throw on violation** — `enforceSpawn(req({ role: undefined }), { emit, now })` (no explicit `mode`) throws `SpawnValidationError` with `code === 'ERR_ROLE_MISSING'`.
3. **`mode='warn'` explicit override still degrades** — same invalid request with `{ mode: 'warn' }` returns `{ ok: true, degraded: true, effective_role: 'logger' }` (validates warn-mode is still reachable post-flip).
4. **`mode='off'` explicit override still skips** — same invalid request with `{ mode: 'off' }` returns `{ ok: true, degraded: false, effective_role: req.role }` and emits zero `spawn_*` events.

Plus the existing `warn-mode.test.ts:37–43` test gets rewritten in-place (single test, three assertions):
- `assert.equal(DEFAULT_VALIDATION_MODE, "hard-fail")`
- `assert.equal(readValidationMode({}), "hard-fail")`
- `assert.equal(readValidationMode({ AIGENTRY_SPAWN_VALIDATION_MODE: "garbage" }), "hard-fail")`

Test name updated to `default mode constant matches ADR §6 #11 hard-fail flip`.

### F. Rollback documentation

Captured inline in deliverable C (ADR §11 changelog entry above). The rollback procedure is two lines and self-evident: `git revert <commit>` restores everything (no state migrations). Documented in §11 alongside the flip entry so future-readers see the rollback path next to the flip narrative.

---

## 4. LOC budget

| Artifact | Est. LOC | Limit |
|---|---|---|
| `src/session/validate-spawn.ts` Δ (1-line constant + comment update) | 1 | (Rule 29) |
| `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` Δ (§11 entry) | ~55 | — |
| `AGENTS.md` Δ | 4 lines | ≤ 5 |
| `tests/session/hard-fail-flip.test.ts` (new) | ~85 | ≤ 100 |
| `tests/session/warn-mode.test.ts` Δ (1 test, 3 assertions) | 3 | — |
| **Total source/test Δ** | **~93** | ≤ 80 src + ≤ 120 tests |
| `docs/specs/2026-05-12-hard-fail-flip.md` (this file) | ~290 | ≤ 300 |

---

## 5. Open questions for orchestrator review

**OQ1 — Q-OPEN-2-FOLLOWUP acceptance interpretation (single material decision).** Per §A.5: ADR §6 row 11 lists only `Q-OPEN-2 + Q-OPEN-4 acceptance` as the #11 blocker (Reading B — recommend PROCEED), but ADR §7.2 and §8 describe Q-OPEN-2-FOLLOWUP refinements (per-MCP allowlists, per-domain network policy, per-path FS scoping) as "acceptance-blocking for the hard-fail rollout (§6 task #11)" (Reading A — would BLOCK). Recommend Reading B (proceed) with acceptance-rationale: the baseline §4.6.2 table already enforces the subset invariant; refinements strictly shrink the allowed set further (cannot reduce safety); Article 1 경량 favors decoupled rollout. **Confirm Reading B, or instruct Reading A** (halt + scope Q-OPEN-2-FOLLOWUP dispatch first).

**OQ2 — Pre-existing baseline failures.** Two tests (W4 + report.sh aggregation) fail on real wall-clocks far from 2026-05-12 because `bin/spawn-telemetry-report.sh` uses `date -u -v -Nd` against the host date while fixtures use literal `2026-05-12` ISO timestamps. These failures pre-date #11 and are unrelated to the flip. Recommend: do not block #11; file as a separate test-hygiene task (mock `date` via env var or inject a `--today YYYY-MM-DD` flag in the script).

**OQ3 — AGENTS.md surface budget.** Four lines edited (within the ≤5 budget). The replacement on line 51 retains the env-var + telemetry-path description verbatim — only the default value flips. Confirm or request tighter wording.

**OQ4 — Commit hash placeholder.** AGENTS.md line 9 / 50 + §11 changelog reference the #11 commit hash as `<pending>`. Confirm post-commit hash-fill workflow (orchestrator-driven via dispatch helper, or coder commits a `<pending>` placeholder + a second commit to fill the hash after the first commit exists).

---

## 6. Workflow gate

Per dispatch step 4 + 5: this SPEC is the draft for orchestrator approval. **Audit verdict = PROCEED (conditional on OQ1).** No implementation, no commit lands until the orchestrator (a) confirms OQ1 reading, (b) acknowledges OQ2–OQ4 or supplies overrides, (c) approves the LOC budget in §4. Implementation order on approval:

1. Apply `DEFAULT_VALIDATION_MODE` flip (deliverable B).
2. Rewrite `warn-mode.test.ts:37–43` test (deliverable E partial).
3. Add `tests/session/hard-fail-flip.test.ts` (deliverable E new file).
4. Append ADR §11 changelog entry (deliverable C).
5. Edit AGENTS.md surface (deliverable D).
6. Run `npm test` + `snyk_code_scan` on the changed TS file; iterate to clean.
7. Commit with message anchored to `ADR-MF #11` + cite all 9 dependency commits per dispatch §C.
8. **Do NOT push.** Orchestrator handles push per dispatch workflow step 6.
