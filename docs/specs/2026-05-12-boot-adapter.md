# SPEC — ADR-MF #13 Per-CLI Boot Adapter

- Status: APPROVED (orchestrator 2026-05-12) — OQ1–5 resolved inline (§10); ready to implement
- Anchor: `docs/adr/2026-05-12-cwd-role-decoupling-immutable-session-contract.md` §4.5 + §4.5.1 + §4.5.1.1 + §6 task #13 (NEW r2 — codex Issue 2)
- Depends on (integrated as-is, zero edits):
  - commit `d06e9cb` — `src/session/types.ts` (#99 / ADR-MF #3)
  - commit `3a13fb5` — `src/session/permission-manager.ts` + `role-capabilities.ts` (#103 / ADR-MF #8)
  - commit `28f94b0` — `src/session/resolve-instructions.ts` + `virtual-fs.ts` (#114 / ADR-MF #4)
  - commit `c24647b` — `src/session/persistence/canonical-bytes.ts` (#101 / ADR §6 #14)
- Blocks: #117 (CLAUDE.md migration) — anti-leak invariant; #121 (#15 gate integration) — Class A/B/C spawn gates
- Constitution: Article 1 경량 (SPEC ≤ 300 lines, src ≤ 400 LOC, tests ≤ 300 LOC), Article 2 크로스 (mac+linux first; Windows documented only), Article 17 무의존 (TS strict, node stdlib only), Rule 29 외과적 변경 (boot-adapter files only)

---

## 1. Why this module exists

ADR §4.5 mandates that L1 child processes launch with **ambient autoload OFF**: a session in `aigentry-orchestrator/` cwd must NOT load that directory's `CLAUDE.md` / `AGENTS.md`. The resolver (#114) produces `ResolvedInstructions.effective_prompt` — a deterministic, layered prompt that is the *only* prompt source the child should receive. Between the resolver and the actual `child_process.spawn`, there is currently no bridge.

This SPEC ships that bridge: **`BootAdapter` per CLI**, each translating `(SessionContext, ResolvedInstructions) → BootCommand` using the per-CLI suppression strategy from ADR §4.5.1, plus a **fail-closed self-test** that verifies (a) installed CLI version ≥ adapter minimum and (b) cwd-CLAUDE.md / equivalent did not leak into the boot prompt.

Without this module, #117 (CLAUDE.md migration) cannot land — backwards-compat symlinks would re-introduce the very leak ADR §4.5 closes.

Consumed by: ADR-MF #15 gate integration (#121) — Class A wrappers call `getBootAdapter(cli).buildBootCommand(...)` to spawn the child, then `verifyBootSelfTest(...)` before declaring the session live.

---

## 2. Scope boundaries

In scope:

1. `BootAdapter` interface + 3 implementations (`claude`, `codex`, `gemini`).
2. Self-test framework (version-drift detection + suppression verification).
3. Registry (`getBootAdapter(cli)`).
4. Fixture stub binaries for hermetic unit testing.
5. Cross-platform (macOS + Linux). Windows: strategy documented in §4.5; impl deferred to #121.

Out of scope:

- The actual `child_process.spawn` orchestration (lives in #121 Class A wrapper).
- Persistence of `boot_self_test` events to disk (lives in #121 telemetry / ADR §6 task #9).
- Global instruction snapshotting bytes (`~/.claude/CLAUDE.md` content into `common` layer) — that read is the resolver's input feed (caller of #114 supplies it). The boot adapter only verifies the resulting `effective_prompt` reaches the child uncorrupted.
- Class B (L2 Agent) boot — ADR §4.5.1 last paragraph: "Class B has no process boot to gate."

---

## 3. `BootAdapter` interface (`src/session/boot-adapter/types.ts`)

```ts
export type CliKind = "claude" | "codex" | "gemini";

export interface BootCommand {
  argv: readonly string[];                   // [executable, ...args]
  env: Readonly<Record<string, string>>;     // env *additions* (merged onto process.env by caller)
  cwd: string;                               // process cwd (scratch control for codex/gemini)
  code_scope_cwd: string;                    // SessionContext.cwd surfaced via CLI native flag (audit field)
  prompt_file: string;                       // absolute path to the staged effective_prompt file
  expected_digest: string;                   // resolved.effective_prompt_digest (echoed for self-test)
}

export interface SelfTestInput {
  ctx: SessionContext;
  resolved: ResolvedInstructions;
  cmd: BootCommand;                          // produced by buildBootCommand()
  spawner?: Spawner;                         // optional injection for tests; defaults to nodeSpawner()
  timeout_ms?: number;                       // default 5_000
}

export interface SelfTestResult {
  adapter: CliKind;
  version: string;                           // CLI semver as reported by --version
  suppression_verified: boolean;             // true ⇔ READY <digest> matched expected_digest
  latency_ms: number;
  errors: readonly BootError[];
}

export type BootErrorCode =
  | "CLI_VERSION_DRIFT"
  | "CLI_NOT_FOUND"
  | "BOOT_DIGEST_MISMATCH"
  | "BOOT_TIMEOUT"
  | "BOOT_LEAK_DETECTED"
  | "UNSUPPORTED_CLI"
  | "ERR_BOOT_ADAPTER_UNSUPPORTED";          // §4.5.1.1 fail-closed (CLI lacks code-cwd flag)

export interface BootError { code: BootErrorCode; detail: string; }

export interface BootAdapter {
  readonly name: CliKind;
  readonly min_version: string;              // adapter pin; bumped when CLI semantics change
  buildBootCommand(
    ctx: SessionContext,
    resolved: ResolvedInstructions,
    opts: { staging_dir: string; fs: VirtualFS },
  ): Promise<BootCommand>;
  verifyBootSelfTest(input: SelfTestInput): Promise<SelfTestResult>;
}
```

`Spawner` is a thin async wrapper around `child_process.spawn` exposed for test injection:

```ts
export interface Spawner {
  run(cmd: BootCommand, stdin?: string, timeout_ms?: number):
    Promise<{ stdout: string; stderr: string; exit_code: number; duration_ms: number }>;
  probeVersion(executable: string): Promise<string>;  // runs `<exe> --version`
}
```

`nodeSpawner()` wraps `node:child_process` with no extra deps. `mockSpawner(scripts)` in `src/session/boot-adapter/spawner.ts` is exported for tests.

---

## 4. Per-CLI adapter strategies

The matrix below derives directly from ADR §4.5.1. `READY <digest>` is the deterministic self-test acknowledgment defined in ADR §4.5.1 last paragraph.

### 4.1 Claude — `src/session/boot-adapter/claude.ts`

- **Suppression:** `claude --bare` (skips cwd `CLAUDE.md` + global `~/.claude/CLAUDE.md` auto-discovery).
- **Prompt injection:** `--system-prompt-file <prompt_file>`. The resolver already prepended global content into `effective_prompt` at digest time per §4.5 decision; the file written by `buildBootCommand` is `resolved.effective_prompt` verbatim (canonical bytes from #114).
- **Process cwd:** `ctx.cwd` (the SessionContext code-scope cwd; `--bare` makes this safe).
- **`code_scope_cwd`:** identical to process cwd; recorded for audit symmetry with codex/gemini.
- **argv:** `["claude", "--bare", "--system-prompt-file", <prompt_file>]`. `--allowedTools` / `--mcp-config` are surfaced by #121 from `SessionContext.permissions` and merged on top by the caller — NOT this SPEC's responsibility (Rule 29; SPEC stays surgical).
- **Version probe:** `claude --version` → semver string; min_version `0.1.0` (placeholder; bumped when ADR §4.5.1 verification confirms upstream flag stability).
- **Self-test transcript:** child stdin receives `\n#READY?\n`; expected stdout substring: `READY <effective_prompt_digest>`. Mismatch ⇒ `BOOT_DIGEST_MISMATCH` + `BOOT_LEAK_DETECTED` (if extraneous content is observed).

### 4.2 Codex — `src/session/boot-adapter/codex.ts`

- **Suppression:** No `--bare` equivalent. Two-layer strategy per ADR §4.5.1.1:
  1. **Scratch control cwd:** adapter creates `${staging_dir}/control/` (empty dir; absent of any `AGENTS.md` / `CODEX.md` / `commands/`) and launches `codex` from there.
  2. **Env var:** `CODEX_NO_CONTEXT_AUTOLOAD=1` is set (defensive — honored if upstream supports it; harmless otherwise). Treated as belt-and-suspenders to the scratch cwd.
- **Prompt injection:** `CODEX_SYSTEM_PROMPT_FILE=<prompt_file>` env var (mirrors claude's flag semantics in env form per the dispatch deliverable; if upstream codex grows a native flag, adapter swaps to the flag and bumps `min_version`).
- **Code-scope cwd surface:** `--cd <ctx.cwd>` (or upstream-equivalent project-root flag). **Fail-closed:** if `probeFeature("--cd")` returns false at adapter construction, `buildBootCommand` throws `ERR_BOOT_ADAPTER_UNSUPPORTED` per ADR §4.5.1.1 — two-axis confusion (collapsing scratch cwd into SessionContext.cwd) is rejected.
- **argv:** `["codex", "--cd", <ctx.cwd>]`. Caller merges any role-capability allowlist via #121.
- **Version probe:** `codex --version`; min_version `0.1.0` (placeholder).
- **Self-test:** same `READY <digest>` contract; stdin `#READY?` prompt, stdout substring match.

### 4.3 Gemini — `src/session/boot-adapter/gemini.ts`

- **Suppression:** Same two-layer strategy as codex — scratch control cwd + `GEMINI_NO_CONTEXT_AUTOLOAD=1`.
- **Prompt injection:** `gemini --system <prompt_file>` (per dispatch; if upstream flag name differs, adapter normalizes inside the file).
- **Code-scope cwd surface:** `--workspace-root <ctx.cwd>` (or upstream equivalent). Fail-closed identical to codex on missing flag.
- **argv:** `["gemini", "--system", <prompt_file>, "--workspace-root", <ctx.cwd>]`.
- **Version probe:** `gemini --version`; min_version `0.1.0` (placeholder).
- **Self-test:** identical `READY <digest>` contract.

### 4.4 Common rules across adapters

- `staging_dir` is supplied by the caller (#121). Adapter writes `<staging_dir>/effective_prompt.md` via `VirtualFS.writeFile` (resolver's existing `VirtualFS` is read-only; this SPEC extends it minimally — see §6).
- `env` field NEVER inherits ambient `CLAUDE_*` / `CODEX_*` / `GEMINI_*` vars; caller's spawn merges them onto a fresh map. The adapter's `env` shape *adds* the suppression + prompt vars only.
- `argv[0]` is always the **executable name** (not absolute path). Resolution is the spawner's job — testable via `mockSpawner` stub.
- Article 17: no shell wrappers — argv is fed straight to `child_process.spawn` with `shell: false`.
- **Version probe is runtime, lazy, fail-fast** (OQ1 resolved). Each adapter declares a `MIN_VERSION` constant (with `// TODO: empirical verification before #11 hard-fail` annotation). The first `buildBootCommand` call probes `<cli> --version` through the injected `Spawner` and caches the result; subsequent calls reuse the cache. Probe failure or `installed < MIN_VERSION` ⇒ `CLI_VERSION_DRIFT` thrown before any FS write or prompt staging.
- **READY `<digest>` is mock-only in r2** (OQ2 resolved). No production CLI implements the `#READY?` stdin sentinel today; the self-test framework parses + validates the contract against `mockSpawner` so adapter logic is compile-time verified, but real leak detection against a live CLI requires upstream cooperation. Tracked as an upstream-gap; until that gap closes, the spawn-time guarantee is "ambient autoload suppression is configured (flag + scratch cwd + env)", not "live ack verifies suppression". This SPEC's source files annotate the gap inline (`// UPSTREAM-GAP: ...`) so #121 + #11 can surface them.
- Suppression env-var names (`CODEX_NO_CONTEXT_AUTOLOAD`, `CODEX_SYSTEM_PROMPT_FILE`, `GEMINI_NO_CONTEXT_AUTOLOAD`) are speculative constants with `// TODO: confirm with upstream CLI before #11 hard-fail` comments (OQ5 resolved). Adapter behavior is correct *if* the var names hold; if upstream uses different names, only the constants change — argv / scratch-cwd / fail-closed surface stays.

### 4.5 Windows (documented; impl deferred to #121)

- `claude --bare` works identically on Windows-native node.
- Codex/Gemini scratch-cwd: replace `${staging_dir}` resolution to use `os.tmpdir()` (already cross-platform). Path separator handled by `path.join`.
- Env vars: identical names.
- Self-test: identical contract; `\n` line endings preserved because the adapter writes bytes through `canonicalBytes()` (#101).

---

## 5. Self-test framework (`src/session/boot-adapter/self-test.ts`)

Single helper `runSelfTest(adapter, input)` encapsulates the fail-closed pipeline:

1. **Version probe.** `await spawner.probeVersion(adapter.name)`. Compare via `semverGte(installed, adapter.min_version)` (≤ 30 LOC in-file comparator; no semver dep). Mismatch ⇒ push `CLI_VERSION_DRIFT` and abort early.
2. **Spawn.** `spawner.run(cmd, "#READY?\n", timeout_ms)`. Exit code ≠ 0 within timeout ⇒ `BOOT_TIMEOUT` (or `CLI_NOT_FOUND` if exec failed pre-spawn).
3. **Digest match.** Search stdout for `READY <cmd.expected_digest>` (exact substring). Miss ⇒ `BOOT_DIGEST_MISMATCH`.
4. **Leak detection.** If stdout contains any sentinel string the adapter pre-registered as "must NOT appear" (e.g., a marker line injected only into cwd-local `CLAUDE.md` fixtures during testing), record `BOOT_LEAK_DETECTED`.
5. **Result.** Build `SelfTestResult{ adapter, version, suppression_verified: errors.length===0, latency_ms, errors }`. Any non-empty `errors` ⇒ caller (#121) MUST refuse to mark the session live (fail-closed).

`semverGte(a, b)` accepts `MAJOR.MINOR.PATCH[-prerelease]`; prerelease lower than any release per SemVer 2 §11. Hand-rolled (≤ 20 LOC) to honor Article 17.

---

## 6. Registry (`src/session/boot-adapter/index.ts`)

```ts
export function getBootAdapter(cli: string): BootAdapter;  // throws UNSUPPORTED_CLI
export { CLI_KINDS, type BootAdapter, type BootCommand, type SelfTestResult, ... };
```

Internally a frozen `Record<CliKind, BootAdapter>` keyed by `name`. Construction wires each adapter with `nodeSpawner()` by default; the spawner is overridable per-call via `verifyBootSelfTest`'s `spawner` field for test isolation.

`VirtualFS` extension: existing #114 `VirtualFS` has `readFile` + `exists`. This SPEC adds two methods to a **new subtype** `BootFS extends VirtualFS` to avoid breaking #114's contract:

```ts
export interface BootFS extends VirtualFS {
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  mkdirP(path: string): Promise<void>;
}
export function nodeBootFs(): BootFS;
export function memoryBootFs(initial?: Record<string, string | Uint8Array>): BootFS;
```

This lives in `src/session/boot-adapter/boot-fs.ts` (≤ 60 LOC). Zero changes to `src/session/virtual-fs.ts` (Rule 29).

---

## 7. Test plan (`tests/session/boot-adapter/*.test.ts`)

Framework: `node --test` + `node:assert/strict`. All tests use `memoryBootFs()` + `mockSpawner()` — hermetic, no real CLI invoked.

Fixture stubs (`tests/fixtures/boot-adapter/`):

- `claude_stub.sh`, `codex_stub.sh`, `gemini_stub.sh` — POSIX `sh` scripts that:
  - On `--version`: print a deterministic version string.
  - On read of stdin `#READY?`: print `READY <digest>` where `<digest>` is derived from the prompt-file arg passed in argv. Used by integration-style tests that exercise `nodeSpawner()` against the stubs (gated by `process.platform !== "win32"`).
- `cwd_leak_marker.md` — fake `CLAUDE.md` placed under a test cwd to verify `--bare` actually suppresses it (real `nodeSpawner()` against stub).

Scenarios (≥ 12 required by dispatch deliverable E):

1. **Registry lookup happy path.** `getBootAdapter("claude" | "codex" | "gemini")` returns each adapter; `.name` matches.
2. **`UNSUPPORTED_CLI` error path.** `getBootAdapter("xyz")` throws `BootError{ code: "UNSUPPORTED_CLI" }`.
3. **Claude argv shape.** `buildBootCommand` returns argv `["claude", "--bare", "--system-prompt-file", <abs path under staging_dir>]`; process cwd === `ctx.cwd`; `prompt_file` exists in `memoryBootFs`.
4. **Codex argv + scratch cwd.** argv contains `--cd <ctx.cwd>`; process cwd === `<staging_dir>/control/` and that dir was `mkdirP`'d empty; `env.CODEX_NO_CONTEXT_AUTOLOAD === "1"` and `env.CODEX_SYSTEM_PROMPT_FILE` points at the staged file.
5. **Gemini argv + workspace-root.** argv contains `--system <prompt_file>` and `--workspace-root <ctx.cwd>`; process cwd is the scratch control dir.
6. **`ERR_BOOT_ADAPTER_UNSUPPORTED` for missing code-cwd flag.** `mockSpawner` reports codex `--cd` probe as unsupported ⇒ `buildBootCommand` throws.
7. **Version-drift detection.** `mockSpawner.probeVersion` returns `"0.0.1"` (below `min_version`) ⇒ `runSelfTest` result has `errors[0].code === "CLI_VERSION_DRIFT"`, `suppression_verified === false`.
8. **`READY <digest>` happy path.** `mockSpawner.run` echoes `READY <expected_digest>\n`; result `suppression_verified === true`, `errors.length === 0`, `latency_ms ≥ 0`.
9. **`BOOT_DIGEST_MISMATCH` path.** Spawner echoes `READY abc123` (wrong digest) ⇒ `BOOT_DIGEST_MISMATCH` recorded; fail-closed.
10. **Leak-marker detection.** Spawner stdout contains pre-registered leak marker (`<<CLAUDE_MD_LEAKED>>`) ⇒ `BOOT_LEAK_DETECTED` recorded even though digest matches.
11. **`BOOT_TIMEOUT` path.** `mockSpawner.run` rejects with `code: "ETIMEDOUT"` ⇒ classified as `BOOT_TIMEOUT`.
12. **Latency tracked.** Result `latency_ms` is a finite non-negative integer ≤ `timeout_ms`.
13. **Prompt file content === resolver `effective_prompt` bytes.** After `buildBootCommand`, `memoryBootFs.readFile(prompt_file)` returns bytes whose sha256 equals `resolved.effective_prompt_digest` — proves no in-flight mutation.
14. **`semverGte` boundary cases.** Unit-level: `0.1.0 ≥ 0.1.0` true; `0.0.9 ≥ 0.1.0` false; `0.1.0-rc.1 ≥ 0.1.0` false (prerelease).
15. **Determinism.** Two calls to `buildBootCommand(ctx, resolved, opts)` with identical inputs produce structurally-equal `BootCommand` (modulo prompt file path being the same staged location); written prompt bytes byte-identical.
16. **Backwards compat sanity.** Importing `src/session/types.ts`, `permission-manager.ts`, `resolve-instructions.ts`, and `persistence/*` does not touch any boot-adapter symbol; round-trip resolve→build self-tests on a `SessionContext` produced by the existing #99 G1-G6 happy-path test fixture.

Estimated test LOC: ~290 (within 300 budget).

---

## 8. File touch list & LOC budget

| File | Status | LOC est. |
|---|---|---|
| `src/session/boot-adapter/types.ts` | new | ~60 |
| `src/session/boot-adapter/boot-fs.ts` | new | ~60 |
| `src/session/boot-adapter/spawner.ts` | new | ~80 |
| `src/session/boot-adapter/self-test.ts` | new | ~80 |
| `src/session/boot-adapter/claude.ts` | new | ~50 |
| `src/session/boot-adapter/codex.ts` | new | ~50 |
| `src/session/boot-adapter/gemini.ts` | new | ~40 |
| `src/session/boot-adapter/index.ts` | new | ~30 |
| `tests/session/boot-adapter/*.test.ts` (4 files) | new | ~290 |
| `tests/fixtures/boot-adapter/*` (3 sh stubs + 1 md) | new | ~30 (out of LOC budget — fixtures) |
| **Total src** | | **~450 / 400 → trim** |
| **Total tests** | | **~290 / 300** |

`src` estimate is slightly over budget — §11 lists trim levers.

Zero edits to `src/session/types.ts`, `validate-spawn.ts`, `permission-manager.ts`, `role-capabilities.ts`, `resolve-instructions.ts`, `virtual-fs.ts`, `project-id.ts`, `persistence/*`. (Rule 29)

---

## 9. Constraints & invariants summary

- TS strict + ESM + node stdlib only (Article 17). No `semver` package; hand-rolled comparator.
- All FS interaction through `BootFS` (writes) or `VirtualFS` (reads).
- All subprocess interaction through `Spawner` interface — `nodeSpawner()` wraps `node:child_process`; `mockSpawner()` for tests.
- Fail-closed: any `errors[]` non-empty ⇒ caller (#121) must abort spawn.
- Prompt-file bytes byte-equal `resolved.effective_prompt` — adapter does NOT re-normalize or mutate.
- Two-axis separation (ADR §4.5.1.1): `BootCommand.cwd` (scratch control) and `BootCommand.code_scope_cwd` (= `SessionContext.cwd`) are surfaced separately; collapsing is rejected.
- Backwards compat: #99 G1–G6 tests, #101 #14 persistence tests, #103 P1 tests, #114 resolver tests all continue to pass unchanged.

---

## 10. Open questions — RESOLVED (orchestrator 2026-05-12)

1. **(OQ1) CLI min_version baseline → runtime probe.** No hardcoded `0.1.0`. Each adapter declares a `MIN_VERSION` constant (e.g., `CLAUDE_MIN_VERSION = "1.0.0"`) annotated with `// TODO: empirical verification before #11 hard-fail`. First `buildBootCommand` call probes `<cli> --version` through the injected `Spawner` and caches the result; `installed < MIN_VERSION` ⇒ `CLI_VERSION_DRIFT`. Builder-sweep is offline / informational, not blocking.
2. **(OQ2) READY `<digest>` upstream cooperation → mock-only.** Production CLIs do not implement the contract today. Self-test framework validates parsing + leak-marker logic via `mockSpawner` only; real-CLI ack is deferred to upstream feature work. Each upstream-gap site annotated `// UPSTREAM-GAP: ...` for #121 + #11 to surface; tracked count emitted in `MF13_IMPL_DONE` report.
3. **(OQ3) BootFS as subtype, NOT hoist.** `BootFS extends VirtualFS` lives in `src/session/boot-adapter/boot-fs.ts`. `src/session/virtual-fs.ts` untouched (Rule 29 + Article 1 경량 + composition).
4. **(OQ4) Probe at construction → fail-fast.** Probe runs on first `buildBootCommand` (the first thing the boot pipeline does) before any FS write or scratch-cwd creation; drift surfaces before spawn attempt, not after. Latency cost (~50ms per adapter init) accepted; cache prevents repeat probes per adapter instance.
5. **(OQ5) Speculative env-var names → placeholder constants with TODO.** `CODEX_NO_CONTEXT_AUTOLOAD`, `CODEX_SYSTEM_PROMPT_FILE`, `GEMINI_NO_CONTEXT_AUTOLOAD` declared as module-scope constants with `// TODO: confirm with upstream CLI before #11 hard-fail`. Changing them is a one-line edit per adapter; argv / fail-closed surfaces are unaffected.

---

## 11. LOC trim levers (if §8 src goes over 400)

In priority order:

- Collapse `claude.ts` + `codex.ts` + `gemini.ts` shared scaffolding into a tiny helper in `boot-adapter/common.ts` (saves ~30 LOC across the three).
- Inline `BootError`/`SelfTestResult` types into `types.ts` (already done in SPEC).
- Move `semverGte` into `self-test.ts` rather than its own file.

If still over, escalate to orchestrator with a request to relax to ≤ 450 LOC src (one Article 1 line-budget bump scoped to this ticket only).

---

## 12. Workflow gate

Per dispatch §Workflow step 4: **stop here**. No `src/` / `tests/` / `bin/` edits until orchestrator approves SPEC. Report line emitted via `telepty inject --ref --submit --submit-retry 2 --from E-coder-mf13-boot-adapter orchestrator` per dispatch §Reporting.
