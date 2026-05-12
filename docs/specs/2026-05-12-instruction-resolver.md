# SPEC — ADR-MF #4 Deterministic Instruction Resolver

- Status: DRAFT (E-coder-mf4-resolver, 2026-05-12)
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.4 + §4.4.1 + §4.8.2 + §6 task #4
- Depends on: commit `d06e9cb` (`src/session/types.ts`, ADR-MF #3 / #99) and commit `c24647b` (`src/session/persistence/canonical-bytes.ts`, ADR §6 #14)
- Aligns with: commit `3a13fb5` (Permission Manager / ADR-MF #8 / #103) — 9-role enum SSOT preserved
- Constitution: Article 1 경량 (src ≤ 350 LOC, tests ≤ 250 LOC, SPEC ≤ 250 lines), Article 17 무의존 (TS strict, node stdlib only), Rule 29 외과적 변경 (resolver-only files + zero edits to #99/#103/#14 sources)

---

## 1. Why this module exists

ADR §4.4 specifies that every L1/L2 session prompt is a **deterministic concatenation of four layers** — `common → project → role → task` — composed from auditable backing-storage files, normalized to canonical bytes, and hashed for snapshot reproducibility (G6 in ADR §4.3).

Today there is no resolver. `validate-spawn.ts` (#99) populates `SessionContext.effective_prompt_digest` but has no module producing the prompt. Persistence (#14) consumes canonical bytes but is content-agnostic. The Permission Manager (#103) gates capabilities but does not touch prompt material. This SPEC fills the gap: **`resolveInstructions()` is the sole producer of `effective_prompt` + `effective_prompt_digest`**, and the sole owner of the §4.4 layer contract.

The resolver is consumed by:

- `validate-spawn.ts` (#99) — receives `ResolvedInstructions` to populate `SessionContext.layers` and `effective_prompt_digest`.
- Persistence (#14 / ADR §6 #5) — writes `effective_prompt.md` and the layers' `source_path` / `content_sha256` to the snapshot.
- Per-CLI boot adapter (ADR-MF #13) — feeds the `effective_prompt` text to the child via `--system-prompt-file` / equivalent.

---

## 2. Scope boundaries

In scope (this SPEC):

1. `resolveInstructions(ctx, fs): ResolvedInstructions` — pure function, deterministic.
2. `VirtualFS` interface + node-fs implementation + in-memory test implementation.
3. Default instruction tree under `~/.aigentry/instructions/` with bootstrap installer.
4. Tests covering layer composition, canonical normalization, digest determinism, missing-layer behavior, and the 9-role enum SSOT.

Out of scope (other tickets):

- Spawn-time invocation, persistence, and gate enforcement (ADR §6 #5 / #14 / #15).
- `project_id` derivation from cwd (ADR §4.4.1 — needed by the spawn pipeline, not the resolver itself; resolver receives `project_id` as input).
- Global instruction snapshotting (`~/.claude/CLAUDE.md` etc., ADR §4.5) — owned by the boot adapter (#13).
- Lint-time conflict detection across layers (ADR §6 task #7).

---

## 3. Resolver API (`src/session/resolve-instructions.ts`)

### 3.1 Inputs

```ts
export interface ResolveContext {
  role: Role;                    // #99 enum SSOT; 9-role catalog (§5.2 below)
  project_id: string | "none";   // derived per ADR §4.4.1 by the caller
  task_prompt: string;           // raw dispatch body — see §3.3 below
  task_source_path: string;      // absolute path of the dispatch file (digest input)
  instructions_root?: string;    // default: `${os.homedir()}/.aigentry/instructions`
}
```

`task_prompt` is the literal bytes the caller intends to ship as the `task` layer. The caller (spawn pipeline) is responsible for already having read the dispatch file; this keeps the resolver's only FS interaction confined to `instructions_root` and makes the resolver trivially testable.

### 3.2 Outputs

```ts
export interface ResolvedInstructions {
  effective_prompt: string;       // canonical text — UTF-8/LF/NFC, no BOM
  effective_prompt_digest: string; // sha256(canonical_bytes(effective_prompt))
  layers: readonly LayerMeta[];   // existing #99 type, ordered common → project → role → task
}
```

`LayerMeta` (already defined in `src/session/types.ts`):

```ts
{ layer: "common"|"project"|"role"|"task"; source_path; content_sha256; read_at }
```

### 3.3 Algorithm

1. Compute each layer source path:
   - `common`: `${root}/common.md`
   - `project`: `${root}/projects/${project_id}.md` (skipped iff `project_id === "none"`)
   - `role`: `${root}/roles/${role}.md`
   - `task`: `task_source_path` (read by caller)
2. For each layer in order:
   - If file exists (via `VirtualFS.exists`): `bytes ← VirtualFS.readFile(path)`; `content_sha256 ← sha256(canonicalBytes(bytes))`; `normalized ← normalize(bytes)`.
   - Else: layer is **omitted** from `layers[]` and contributes no content. (Dispatch deliverable: "Missing layer → graceful skip + digest still deterministic.")
   - **Note vs ADR §4.4.** ADR says missing layer → "fail the spawn (G6 fails)". The resolver is a *pure producer*; the *gate* (Class A/B/C, ADR §4.3) is the enforcer. This SPEC defers required-layer enforcement to the gate, matching dispatch deliverable and keeping the resolver useful in tests / dry-runs. Open question #1 below.
3. `effective_prompt = normalized_layers.join("\n\n---\n\n")` (ADR §4.4 delimiter contract).
4. Trailing newline: exactly one LF.
5. `effective_prompt_digest = sha256Hex(canonicalBytes(effective_prompt))` — reusing `src/session/persistence/canonical-bytes.ts` (no duplication).
6. Return `{ effective_prompt, effective_prompt_digest, layers }`.

### 3.4 Determinism contract

For identical `(role, project_id, task_prompt, task_source_path, instructions_root)` and identical file bytes under `instructions_root`, two invocations must return byte-identical `effective_prompt` and `effective_prompt_digest`.

`read_at` is the only field that varies between calls; it does NOT participate in `effective_prompt_digest` (the digest is over the concatenated text, not over `LayerMeta`). `content_sha256` per layer is stable.

---

## 4. Canonical normalization

Each layer's bytes are normalized via `canonicalBytes()` from `persistence/canonical-bytes.ts` (already shipped in #14):

- Strip leading BOM (U+FEFF).
- CRLF / CR → LF.
- Unicode NFC normalization.
- UTF-8 encoding.

Additional per-layer trimming inside the resolver (ADR §4.4 "trimmed of trailing whitespace per line, and terminated with exactly one LF"):

- Trim trailing spaces/tabs on each line (preserve interior whitespace).
- Strip trailing blank lines, then re-append one LF.

The full effective prompt is `layers.join("\n\n---\n\n")` — delimiter is verbatim from ADR §4.4. The final string passes through `canonicalBytes()` one more time before hashing (idempotent; defensive against future regressions).

---

## 5. Default instruction tree

### 5.1 Layout

```
~/.aigentry/instructions/
├── common.md                  # universal runtime/location rules (placeholder; user overrides)
├── projects/                  # optional; created empty by installer
└── roles/
    ├── orchestrator.md
    ├── architect.md
    ├── coder.md
    ├── tester.md
    ├── builder.md
    ├── analyst.md
    ├── researcher.md
    ├── reviewer.md
    └── logger.md
```

### 5.2 Role catalog — SSOT alignment

The 9 roles match `src/session/types.ts` `Role` enum (#99, commit `d06e9cb`) exactly:

`orchestrator, architect, coder, tester, builder, analyst, researcher, reviewer, logger`

**Dispatch text inconsistency.** The dispatch lists `dustcraw` in place of `researcher`. The #99 enum and the #103 `ROLE_CAPABILITIES` registry both have `researcher`; `dustcraw` appears nowhere in the codebase. This SPEC follows the #99 SSOT (Article 17 + Rule 29: never invent a role not in the enum). See Open question #2 below.

### 5.3 Placeholder content

Each role file is a single-sentence placeholder describing the role's responsibility (≤ 3 lines). `common.md` is a short universal frame (≤ 6 lines). Users override post-install; the installer never overwrites existing files.

Total placeholder content across 10 files: ≤ 60 LOC.

### 5.4 Bootstrap installer — `bin/install-instructions.sh`

- Idempotent: only `mkdir -p` directories that are missing; only `cat > file` when file does **not** exist.
- Resolves `~` via `${HOME:-$HOME}` (POSIX-safe; matches existing `bin/dispatch.sh` style).
- Prints what it created vs skipped (one line per path) for operator visibility.
- Exit 0 on success; exit non-zero only on FS error.
- No external deps; pure `sh` + `mkdir` + `cat`. ≤ 60 LOC.

---

## 6. VirtualFS abstraction (`src/session/virtual-fs.ts`)

```ts
export interface VirtualFS {
  readFile(path: string): Promise<Uint8Array>;
  exists(path: string): Promise<boolean>;
}
export function nodeFs(): VirtualFS;          // wraps node:fs/promises
export function memoryFs(map: Map<string, Uint8Array | string>): VirtualFS;
```

`memoryFs()` is the test implementation: a Map keyed by absolute path. String values are encoded as UTF-8 for convenience; Uint8Array values pass through unchanged (so tests can construct CRLF / BOM / NFD fixtures byte-precisely).

Async-by-default — node:fs/promises is the underlying API; the resolver is `async`. This is consistent with persistence-track modules (#14 uses async fs).

≤ 50 LOC total.

---

## 7. Test plan (`tests/session/resolve-instructions.test.ts`)

Framework: `node --test` + `node:assert/strict` (matches existing test suite). All tests use `memoryFs()` so they are hermetic — zero filesystem touch.

Required scenarios (≥ 10, dispatch deliverable D):

1. **All 4 layers present → composition order correct.** Common, project, role, task each emit a unique marker; concatenated `effective_prompt` matches `[c, p, r, t].join("\n\n---\n\n") + "\n"`.
2. **Layer source identity recorded.** Each `LayerMeta` has correct `layer`, `source_path`, non-empty `content_sha256`, and a parseable `read_at` ISO-8601 timestamp.
3. **Missing project layer (project_id="none") → 3-layer output.** Resolver returns `layers.length === 3`, no project entry; digest is stable across two calls.
4. **Missing role file → 3-layer output (graceful).** Verifies resolver does not throw on missing role file (gate's job to fail, not resolver's).
5. **Determinism — same input twice → identical digest.** Two back-to-back calls produce identical `effective_prompt_digest` and identical `effective_prompt` bytes.
6. **CRLF → LF normalization.** Input layer with CRLF endings produces same digest as the LF-only equivalent.
7. **NFD → NFC normalization.** Input containing combining sequences (e.g., decomposed Hangul `ᄒ +  ᅡ + ᆫ`) produces the same digest as the precomposed `한`.
8. **BOM strip.** Layer prefixed with U+FEFF produces same digest as the BOM-less equivalent.
9. **Trailing-whitespace trim per line.** Layer with `"foo   \nbar\t\n"` normalizes identically to `"foo\nbar\n"`.
10. **9 roles each resolve correctly.** Loop over `ROLES` from `types.ts`; each yields a `role` layer with `source_path` ending in `roles/${role}.md`.
11. **Empty common.md → digest stable.** Zero-byte `common.md` still produces a deterministic digest reproducible across two calls.
12. **Layer ordering is lexically enforced.** Manually shuffle the input order of the in-memory map; output still composes common → project → role → task. (Defends against future refactors that might iterate `Object.entries` over an unsorted source.)
13. **Delimiter contract.** `effective_prompt.split("\n\n---\n\n").length === layers.length`. Critical for ADR §4.4 audit requirement.
14. **Digest cross-check vs `canonicalBytes`.** `effective_prompt_digest === sha256Hex(canonicalBytes(effective_prompt))` — verifies the resolver does not reinvent hashing.

Estimated test LOC: ~220 (well within 250-LOC budget).

---

## 8. File touch list & LOC budget

| File | Status | LOC est. |
|---|---|---|
| `src/session/resolve-instructions.ts` | new | ~180 |
| `src/session/virtual-fs.ts` | new | ~50 |
| `bin/install-instructions.sh` | new | ~60 |
| `~/.aigentry/instructions/common.md` + `roles/*.md` × 9 | installer output (not committed) | ~60 |
| `tests/session/resolve-instructions.test.ts` | new | ~220 |
| **Total src** | | **~230 / 350** |
| **Total tests** | | **~220 / 250** |

Zero edits to `src/session/types.ts`, `src/session/validate-spawn.ts`, `src/session/permission-manager.ts`, `src/session/role-capabilities.ts`, or `src/session/persistence/*` (Rule 29).

---

## 9. Constraints & invariants summary

- TS strict + ESM + node stdlib only (Article 17).
- All FS interaction goes through `VirtualFS` — no direct `fs` import in `resolve-instructions.ts`.
- Reuse `canonicalBytes` + `sha256Hex` from `persistence/canonical-bytes.ts` — do not reimplement.
- Backwards compat: #99 G1-G6 tests, #103 P1 tests, #14 persistence tests continue to pass (no source edits in those packages).
- No mutation: `ResolvedInstructions` and `LayerMeta[]` are returned frozen (Object.freeze on the array).

---

## 10. Open questions for orchestrator

1. **Missing-layer semantics (resolver vs gate split).** ADR §4.4 says missing required layer fails the spawn at G6; dispatch deliverable says "graceful skip + digest deterministic". This SPEC reconciles by making the *resolver* always-succeeds (returns whatever it found) and leaving required-layer enforcement to the gate (ADR §6 task #15). Confirm this is the intended split, or have the resolver throw `ERR_LAYER_MISSING` when `role` or `common` is absent.
2. **Role catalog discrepancy.** Dispatch lists `dustcraw`; #99 SSOT has `researcher`. SPEC follows SSOT. Confirm dispatch text was a typo, or ratify a 10th role in #99 + #103 first (would block this SPEC).
3. **Installer location.** `bin/install-instructions.sh` lives in the orchestrator repo; the files it installs are user-global at `~/.aigentry/instructions/`. Confirm this is acceptable, or whether the SPEC should also offer a `--dry-run` and a `--prefix` override for CI / test environments.
4. **`project_id` derivation.** Resolver takes `project_id` as input rather than re-deriving from `cwd` per ADR §4.4.1 (which is the spawn pipeline's job). Confirm the split.

---

## 11. Workflow gate

Per dispatch §Workflow: stop here. Await orchestrator approval before any `src/`/`tests/`/`bin/` edits. Report line emitted via `telepty inject --ref --submit` per dispatch §Reporting.
