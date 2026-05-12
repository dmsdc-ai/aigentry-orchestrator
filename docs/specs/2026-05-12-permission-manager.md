# SPEC — ADR-MF #8 Permission Manager (role → capability + subset propagation)

- Status: DRAFT (E-coder-mf-permission, 2026-05-12)
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.6 + §4.6.1 + §4.6.2 + §6 task #8
- Depends on: commit `d06e9cb` (`src/session/types.ts` + `src/session/validate-spawn.ts`, #99 / ADR-MF #3)
- Scope of this SPEC: deliverables A/B/C/D from dispatch `Dispatch — E-coder-mf-permission — ADR-MF #8 (#103)`
- Constitution: Article 1 경량 (impl src ≤ 300 LOC, tests ≤ 250 LOC), Article 17 무의존 (TS strict, node stdlib only), Rule 29 외과적 변경 (touch validate-spawn minimally)

---

## 1. Why this module exists

`validate-spawn.ts` (#99) implements the parent/role/cwd/task/cycle invariants of ADR §4.3 (G1, G3, G4, plus pre-snapshot operational gates), but the ADR §4.3 **G5 — capability subset** invariant is delegated to a "Permission Manager" (§4.6). #103 builds that manager.

Three concerns are bundled:

1. **role → capability lookup** — a declarative table answers "what may a freshly spawned `X`-role do by default?" (ADR §4.6.2).
2. **subset propagation** — a child's effective capability set never exceeds the parent's; the parent's set is the upper bound (ADR §4.6 + WASI/seL4 capability-based-security analogue).
3. **eligibility decision** — before a spawn is admitted (Class A/B/C, §4.3), the request's claimed capabilities must (a) be a subset of the role-default, (b) be a subset of the parent's effective set.

The output is consumed by:

- `validate-spawn.ts` (#99) — extended with a single new typed-error path.
- The boot-adapter (#104 / ADR-MF #13) — receives the propagated `CapabilitySet` to translate into per-CLI flags via the §4.6.1 adapter table.

---

## 2. Naming discipline — collision with #99 "G1–G6" labels

ADR §4.3 labels its invariants G1…G6 (role / parent_role / role-override / orchestrator-child / capability-subset / digest-precommit). #99 reuses the labels **G1–G6** for its concrete validator (role / orchestrator-clone / role-override / cwd / task / cycle). The label sets overlap conceptually but are **not** position-equivalent.

This SPEC introduces no new G-label. The Permission Manager check is named **`P1 — capability subset`** (capital P, distinct from G) and is invoked from `validateSpawn(...)` after #99's G1–G6 pass. The ADR §4.3 "G5" invariant is satisfied by P1; ADR §4.3 "G6" (digest precommit) remains owned by #5 + #14 (persistence track) and is **out of scope for this SPEC**.

A short note in `validate-spawn.ts` header comment will record this label mapping (≤ 6 lines).

---

## 3. Module API surface

### 3.1 New module — `src/session/permission-manager.ts`

```ts
// Capability identifiers — closed set per ADR §4.6 minimum table.
// Finer-grained capabilities (per-MCP allowlist, per-domain network) = Q-OPEN-2-FOLLOWUP, out of scope.
export const CAPABILITIES = [
  "spawn_l1", "spawn_l2",
  "read_fs", "write_fs",
  "bash", "network",
  "mcp_deliberation", "task_dispatch",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type CapabilitySet = ReadonlySet<Capability>;

// Discriminated result mirrors validate-spawn's shape.
export type PermissionErrorCode =
  | "ERR_ROLE_UNKNOWN"               // role missing from registry (defensive — validate-spawn G1 catches first)
  | "ERR_CAPABILITY_UNKNOWN"         // request lists a capability outside CAPABILITIES set
  | "ERR_CAPABILITY_DENIED"          // requested cap not in role-default
  | "ERR_CAPABILITY_EXPANSION"       // requested cap not in parent's set (subset violation)
  | "ERR_INVALID_REQUEST";           // structural (e.g. requested is non-Set / non-array)

export type PermissionResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: PermissionErrorCode; detail: string };

// (A) role → capability lookup.
export function roleToCapabilities(role: Role): CapabilitySet;

// Returns the *effective* capability set the child should carry: the intersection of
// (parent caps) ∩ (requested caps OR role-default if requested omitted), with explicit
// expansion attempts rejected (not silently dropped).
export function propagateSubset(
  parent_caps: CapabilitySet,
  request: { role: Role; requested?: Iterable<Capability> },
): PermissionResult<CapabilitySet>;

// (C) Eligibility decision for validate-spawn integration.
// Returns the child's effective CapabilitySet on success.
export function checkSpawnPermissions(
  parent: SessionContext | undefined,
  request: SpawnRequest,
): PermissionResult<CapabilitySet>;
```

- `roleToCapabilities` is a **pure** function over the registry (no I/O).
- `propagateSubset` enforces the invariant **child ⊆ parent**; an attempt to add a capability the parent lacks is `ERR_CAPABILITY_EXPANSION`, **not** silent drop. Silent drop would mask buggy dispatches.
- `checkSpawnPermissions` is the integration shim called from `validateSpawn`.

### 3.2 New types extending the #99 contract — `src/session/types.ts`

Extend `SessionContext` and `SpawnRequest` with **optional** fields (backwards-compat preserved):

```ts
// Adds to existing SessionContext interface
permissions?: readonly Capability[];   // canonical sorted array on disk; Set in memory via helper

// Adds to existing SpawnRequest interface
requested_permissions?: readonly Capability[];   // omit ⇒ inherit role-default
```

The on-disk shape is `readonly Capability[]` (deterministic JSON sort order per ADR §4.8.2). In-memory `CapabilitySet` is constructed lazily; permission-manager exposes `toSortedArray(set)` / `fromArray(arr)` helpers.

Adding an *optional* field on a TypeScript interface is **not** a breaking change for `strict` consumers (existing tests do not set it; #99 tests pass unmodified — verified mental walk-through of `tests/session/types.test.ts` and `tests/session/validate-spawn.test.ts`).

### 3.3 Touch-point in `src/session/validate-spawn.ts` (Rule 29 minimal)

Two surgical edits:

1. Extend the union `ValidateSpawnErrorCode` with `"ERR_CAPABILITY_DENIED" | "ERR_CAPABILITY_EXPANSION" | "ERR_CAPABILITY_UNKNOWN"`.
2. After the existing `g6Cycle` line in `validateSpawn(...)`, append a `p1Permissions(...)` step that calls `checkSpawnPermissions` and projects its `PermissionResult` onto `ValidateSpawnResult`. When `req.requested_permissions` is `undefined` AND `opts.parent?.permissions` is `undefined`, P1 is a **no-op pass** — this preserves every existing #99 test verbatim.

No removals; no renames; no behavior change when the new optional fields are absent.

---

## 4. Role → capability registry

### 4.1 Storage choice

ADR §6 task #8 row says "`src/session/permissions.ts`, `~/.aigentry/permissions/`". The dispatch allows "YAML or TS config at `config/role-capabilities.yaml` (or .ts)". Constraints:

- Article 17 무의존: no YAML parser may be added (none in `package.json`). YAML therefore requires either a new dep (rejected) or a hand-written micro-parser (over-engineering for #103). TS is the obvious choice.
- The `~/.aigentry/permissions/` runtime-override directory is a **Phase 2** (Q-OPEN-2-FOLLOWUP / fine-grained refinements) concern. Phase 1 (this SPEC) ships the **compile-time TS literal** as the SSOT.

**Decision:** registry lives at `src/session/role-capabilities.ts` as a frozen `Record<Role, readonly Capability[]>`. The future `~/.aigentry/permissions/{role}.json` override mechanism is left as a TODO comment + open question — not implemented here.

### 4.2 Default registry (transcribed from ADR §4.6.2)

ADR §4.6.2 covers **8 roles** (no `reviewer`). #99's `Role` enum has **9** roles (includes `reviewer`). The dispatch claims **"10 roles … orchestrator / coder / reviewer / architect / dustcraw / analyst / builder / logger / tester / project-impl"** — `dustcraw` and `project-impl` exist in neither the ADR nor the #99 enum, and would require a breaking change to the `Role` enum (rejected per Rule 29 + #99 backwards-compat).

**Decision:** The SSOT for roles is the `Role` enum in `src/session/types.ts` (#99). The registry covers all 9 enum values. The 8 ADR §4.6.2 entries are transcribed verbatim; `reviewer` is given an explicit, conservative mapping documented inline.

| Role | spawn_l1 | spawn_l2 | read_fs | write_fs | bash | network | mcp_deliberation | task_dispatch |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `orchestrator` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `architect`    | ✓ | ✓ | ✓ | ✓ | — | — | ✓ | ✓ |
| `coder`        | — | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `tester`       | — | ✓ | ✓ | — | ✓ | — | — | — |
| `builder`      | — | — | ✓ | — | ✓ | ✓ | — | — |
| `analyst`      | — | ✓ | ✓ | — | — | — | — | — |
| `researcher`   | — | ✓ | ✓ | — | — | ✓ | ✓ | — |
| `reviewer`     | — | ✓ | ✓ | — | — | — | ✓ | — |  ← added (mirrors `analyst` + `mcp_deliberation` for cross-LLM review)
| `logger`       | — | — | ✓ | — | — | — | — | — |

Notes (transcribed from ADR §4.6.2 where applicable):

- `orchestrator.bash` — ADR table reads "(subset; per Rule 13 builder delegation)". The capability is `true` here; *Rule 13 subset-by-delegation* is operational discipline, not a capability bit. Comment marker in the registry records this.
- `architect.write_fs` — ADR reads "(docs only)". Same comment: per-glob scoping is Q-OPEN-2-FOLLOWUP; the capability bit is `true`.
- The `(subset — may spawn researcher / grader)` annotation on `architect.spawn_l1` similarly resolves to `true` at this granularity.

Annotating sub-glob scope as Q-OPEN-2-FOLLOWUP in this SPEC is deliberate: ADR §7.2 + §8 "Resolved in r2" explicitly defers per-glob/per-domain scoping. Trying to express it now would inflate the registry beyond the LOC budget.

### 4.3 Registry invariants (enforced by `role-capabilities.test.ts`)

- Every key of the registry is a valid `Role` (enum exhaustiveness).
- Every value is a subset of `CAPABILITIES` (no typos, no orphans).
- Registry is frozen — `Object.isFrozen(REGISTRY) === true`.

---

## 5. Integration with `validate-spawn.ts` (Rule 29 minimum)

### 5.1 Call shape (after #99 G6, before `{ ok: true }`)

```ts
// existing #99 chain unchanged:
return (
  g1Role(req) ?? g2OrchestratorClone(req, opts.parent) ?? g3RoleOverride(req, opts.parent)
  ?? g4Cwd(req, opts) ?? g5Task(req) ?? g6Cycle(req, opts)
  ?? p1Permissions(req, opts)                        // NEW — 4 lines
  ?? { ok: true }
);
```

`p1Permissions` is a 6–12 line adapter inside `validate-spawn.ts` that delegates to `checkSpawnPermissions` and maps `PermissionErrorCode` → `ValidateSpawnErrorCode` (1:1 string-equal codes; map is identity).

### 5.2 No-op semantics in the absence of capability data

When **both** `opts.parent?.permissions` is undefined **and** `req.requested_permissions` is undefined, `p1Permissions` returns `undefined` (gate passes). This guarantees every existing `validate-spawn.test.ts` case in #99 still passes (none of those tests set capability fields).

### 5.3 What `p1Permissions` does when data *is* present

| `parent.permissions` | `req.requested_permissions` | Behavior |
|---|---|---|
| undefined | undefined | no-op pass (§5.2) |
| undefined | defined   | request validated against `roleToCapabilities(req.role)` only (no parent ceiling). Allowed because Class A root spawn may have no parent. |
| defined   | undefined | child receives `parent.permissions ∩ roleToCapabilities(req.role)` (parent caps capped to role-default). No error. |
| defined   | defined   | each requested cap must be in **both** `parent.permissions` (else `ERR_CAPABILITY_EXPANSION`) and `roleToCapabilities(req.role)` (else `ERR_CAPABILITY_DENIED`). Unknown identifiers ⇒ `ERR_CAPABILITY_UNKNOWN`. |

The propagated `CapabilitySet` is **not stored back into `req`** by `validateSpawn` (the function remains side-effect-free per #99 convention). The boot-adapter (#104) calls `checkSpawnPermissions` directly to obtain the propagated set; `validateSpawn` only confirms the *legality* of the request.

---

## 6. Error taxonomy

All errors share `ValidateSpawnResult` shape (`{ ok:false; code; detail }`).

| Code | When | Mapped from |
|---|---|---|
| `ERR_ROLE_UNKNOWN`           | role not in registry (defensive; #99 G1 normally catches first) | `PermissionErrorCode.ERR_ROLE_UNKNOWN` |
| `ERR_CAPABILITY_UNKNOWN`     | requested identifier outside `CAPABILITIES` | `PermissionErrorCode.ERR_CAPABILITY_UNKNOWN` |
| `ERR_CAPABILITY_DENIED`      | requested cap not in role-default | `PermissionErrorCode.ERR_CAPABILITY_DENIED` |
| `ERR_CAPABILITY_EXPANSION`   | requested cap not in parent's set (subset violation) | `PermissionErrorCode.ERR_CAPABILITY_EXPANSION` |
| `ERR_INVALID_REQUEST`        | non-iterable `requested_permissions`, non-string entries | `PermissionErrorCode.ERR_INVALID_REQUEST` |

`detail` strings follow the `<reason>: <offending-value>` format already established by #99.

Reporting (per Rule 30): rejections are surfaced via the existing `ValidateSpawnResult` channel; the orchestrator's self-correction loop consumes them. The Permission Manager itself does **not** log, throw, or emit telemetry — telemetry is #9's job (ADR §6 task #9, warn-mode).

---

## 7. Test plan

All tests use `node:test` (no jest/vitest — `package.json` declares only `node:test` via `node --test dist/tests`, Article 17 무의존).

### 7.1 `tests/session/role-capabilities.test.ts` (4 cases, ~50 LOC)

1. Every `Role` enum value has an entry in the registry (exhaustiveness).
2. Every entry's caps are a subset of `CAPABILITIES`.
3. `Object.isFrozen(REGISTRY)` and each entry value is frozen.
4. Spot-check 3 known mappings (`orchestrator` includes `spawn_l1`; `coder` excludes `spawn_l1`; `logger` is `{read_fs}` only).

### 7.2 `tests/session/permission-manager.test.ts` (12 cases, ~170 LOC)

`roleToCapabilities` — (5) expected set per role (parameterized over 9); (6) returned `Set` is independent of registry mutation.

`propagateSubset` — (7) `requested` omitted ⇒ `parent ∩ role-default`; (8) `requested ⊆ parent ∩ role-default` ⇒ equals `requested`; (9) cap missing from `parent` ⇒ `ERR_CAPABILITY_EXPANSION` with offending cap in `detail`; (10) cap missing from `role-default` ⇒ `ERR_CAPABILITY_DENIED`; (11) unknown identifier ⇒ `ERR_CAPABILITY_UNKNOWN`.

`checkSpawnPermissions` — (12) both fields undefined ⇒ pass with `roleToCapabilities(req.role)` (boot-adapter fallback); (13) parent defined / request undefined ⇒ pass with intersected caps; (14) both defined, in-bounds ⇒ pass with `requested`; (15) request asks expansion ⇒ `ERR_CAPABILITY_EXPANSION`; (16) parent undefined + unknown cap ⇒ `ERR_CAPABILITY_UNKNOWN`.

### 7.3 `tests/session/validate-spawn.test.ts` — additions (4 cases, ~50 LOC; existing 7 #99 cases unchanged)

17. Backwards-compat: all 7 existing tests pass byte-for-byte (verified by **not** modifying them; CI runs them too).
18. P1 — parent without `permissions` + request without `requested_permissions` ⇒ existing happy path still passes (regression guard for §5.2 no-op).
19. P1 — request asks `spawn_l1` when parent's role is `coder` (no `spawn_l1`) ⇒ `ERR_CAPABILITY_EXPANSION`.
20. P1 — request lists `"god_mode"` ⇒ `ERR_CAPABILITY_UNKNOWN`.

**Total: 20 cases (12 dispatch threshold satisfied with margin).**

---

## 8. LOC estimate

| File | LOC est. | Notes |
|---|---:|---|
| `src/session/permission-manager.ts`        | ~140 | API + 3 functions + error formatting |
| `src/session/role-capabilities.ts`         |  ~55 | 9-row registry + freeze helpers |
| `src/session/types.ts` (additions)         |   +6 | 2 optional fields + 1 re-export |
| `src/session/validate-spawn.ts` (additions)|  ~18 | `p1Permissions` adapter + error union widen + header comment |
| **Subtotal — src**                         | **~219** | ≤ 300 budget ✓ |
| `tests/session/role-capabilities.test.ts`  |  ~55 |
| `tests/session/permission-manager.test.ts` | ~170 |
| `tests/session/validate-spawn.test.ts` (additions) | ~50 |
| **Subtotal — tests**                       | **~225** | ≤ 250 budget ✓ |
| `docs/specs/2026-05-12-permission-manager.md` | ~270 | this file, ≤ 300 budget ✓ |

Cushion is ~25% for src and ~10% for tests — tight on tests but feasible because cases share `parent()` / `req()` builders already proven in #99.

---

## 9. Open questions (Q-OPEN-PM-*)

1. **Q-OPEN-PM-1 — Role mismatch with dispatch text.** Dispatch lists 10 roles including `dustcraw` and `project-impl`; ADR §4.6.2 lists 8; #99 enum has 9 (adds `reviewer`). This SPEC ships with **the 9 of #99** and explicitly maps `reviewer`. **Question for orchestrator:** are `dustcraw` / `project-impl` real upcoming roles? If yes, who owns the Role-enum extension PR — this SPEC, or #104 / a later task? Recommended: defer until ADR is amended.
2. **Q-OPEN-PM-2 — Runtime override directory `~/.aigentry/permissions/`.** ADR §6 task #8 mentions it, but no protocol is specified. This SPEC implements compile-time registry only. Phase-2 follow-up to design the override loader (deterministic merge order, canonical-bytes parity with §4.8.2). Out of scope.
3. **Q-OPEN-PM-3 — Per-glob/per-domain scoping** (`write_fs:docs/**`, `network:api.anthropic.com`). Tracked as Q-OPEN-2-FOLLOWUP in the ADR (§7.2 + §8). Out of scope for r1.
4. **Q-OPEN-PM-4 — `task_dispatch` semantics.** ADR §4.6.1 says it's "not native; via `telepty inject` from inside session (requires `bash` capability)". This SPEC carries it as a first-class bit, not as a derived view of `bash`. If `bash` is the true SSOT, `task_dispatch` becomes a derived property and should be removed from the registry. Defer to integration with #104 boot-adapter to confirm.

---

## 10. Out of scope

- ADR §4.3 **G6 — digest precommit** (owned by #5 / #14).
- Persistence to `~/.aigentry/sessions/{sid}/permissions.json` (owned by #5).
- Per-CLI translation of the propagated `CapabilitySet` into `--allowedTools` / sandbox flags (owned by #104 / ADR-MF #13).
- Warn-mode / telemetry of denied spawns (owned by #9).
- Cycle detection — already provided by #99 G6; Permission Manager does not duplicate it.

---

## 11. Approval gate

This SPEC blocks impl per Article 5 + Rule 24 (SPEC FIRST). Awaiting orchestrator decision on:

- (a) approve as-is — proceed to impl,
- (b) approve with answers to Q-OPEN-PM-1 / Q-OPEN-PM-4,
- (c) revise (specify revision).

Reporting per dispatch reporting block on completion.
