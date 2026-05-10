# Telepty Bilingual Ops Cost Analysis (2026-05-10)

> Precondition C4 brief — quantitative ops-cost comparison of three telepty supervisor architecture paths, produced by `aigentry-analyst-c4-bilingual` for orchestrator review prior to commit.

---

## §1 Executive Summary

**Recommendation**: **Path B (Rust sidecar bilingual)** — conditional on precondition C2 (cdylib PoC) PASS.
**Fallback**: **Path A (Node 0.3.x maintained)** if C2 FAILs or contributor pool blocks.
**Path C (Go full migration)** is **dominated** and should not be selected.

**Top 3 cost drivers (across all paths)**:
1. **CI pipeline duration multiplier from cargo addition** — +1.5x to +3.5x wall-clock on PR (mitigated to ~+1.5x with sccache + cargo-chef + nextest, but never to parity).
2. **Cross-language schema sync overhead** for IPC frames — empirically +10–15% per feature touching the boundary (Mozilla application-services case data; not all features, but all cross-cutting ones).
3. **Onboarding & debug surface 2x** for Path B — two stacks, two profilers, two cache strategies. Not free even with strong tooling.

**Decision dependency on C2**:
- C2 = `cdylib + N-API` cdylib PoC for Rust sidecar embedding into existing Node daemon.
- **C2 PASS** → Path B viable: Rust sidecar handles PTY/ConPTY/multiplex, Node retains CLI/MCP surface. Bilingual cost paid once, not per ecosystem migration.
- **C2 FAIL** → Path B becomes Path C-shaped (full process boundary, doubled IPC cost, no incremental migration). Recommendation collapses to Path A + targeted hardening of issues #14/#15.

**Why Path C is dominated**: Go's standard `os/exec` cannot set the `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` attribute required by Windows ConPTY (Go upstream #62708, #6271). Telepty's core value is PTY supervision; the only language with mature ConPTY tooling at this layer is Rust (portable-pty, originally from wezterm). Choosing Go forfeits the primary architectural justification for any rewrite.

---

## §2 Methodology

### 2.1 Seven-dimension matrix

For each path P ∈ {A, B, C}, score on:
1. Initial rewrite cost (LOC + person-weeks)
2. CI build-time per PR (wall-clock, p50)
3. CI cache strategy complexity (number of independent caches × invalidation surface)
4. Schema sync overhead per feature
5. Debug surface (concurrent stacks × tool count)
6. Onboarding cost (time-to-first-PR for new contributor)
7. Long-term maintenance trajectory (ecosystem volatility, bus-factor)

### 2.2 Measurement methodology

- **CI baseline**: `gh run list --repo dmsdc-ai/aigentry-telepty` + `gh run view <id> --json jobs` for per-job `startedAt`/`completedAt` deltas. Last 20 runs analysed.
- **LOC baseline**: `find . -name "*.js" | xargs wc -l` on telepty 0.3.5 working tree (`~/projects/aigentry-telepty`).
- **Reference LOC**: GitHub Languages API via `gh api repos/<org>/<repo>/languages`.
- **Industry overhead**: web search for case studies (Discord, Mozilla application-services, Depot/Earthly Rust CI guides, sccache-action).
- All speculative figures explicitly tagged **(speculation)**.

### 2.3 Reference projects

| Project | Primary language | LOC (bytes via GitHub Languages API) | Role |
|---|---|---|---|
| zellij | Rust | 10,045,287 | Rust terminal multiplexer (closest functional analogue to telepty supervisor scope) |
| alacritty | Rust | 1,143,884 | Rust terminal emulator (PTY consumer reference) |
| wezterm | Rust | 15,500,008 | Rust multiplexer + emulator; **upstream of `portable-pty` crate** |
| tmux | C | 2,421,578 | C multiplexer (legacy comparator) |
| **telepty 0.3.5** | **JS** | **~16,175 LOC (text-line count)** | **subject under analysis** |

Bytes-vs-line-count are not directly comparable — included to bracket the order of magnitude. Telepty is **~3 orders of magnitude smaller** than zellij/wezterm. Implication: a rewrite is *tractable in absolute terms* but the ratio of **ops investment to feature surface** is what this analysis quantifies.

---

## §3 Path A — Node 0.3.x maintained (no rewrite)

### Dim 1 — Initial rewrite cost
**~0 LOC.** Effort = patch issues #14 (uuid@11 ESM, **already CLOSED**) and #15 (daemon version-mismatch self-restart, **OPEN**), estimate 3–5 person-days.

### Dim 2 — CI build time per PR
**Empirical baseline (from `gh run view`)**:
- Workflow: `Regression Tests` (`.github/workflows/test-install.yml`)
- Matrix: `{ubuntu-latest, macos-latest, windows-latest} × Node 20`
- Sample run `25367739350` (2026-05-05 fast-fail):
  - ubuntu: 09:11:28 → 09:12:02 = **34 s**
  - macos: 09:11:23 → 09:12:06 = **43 s**
  - windows: 09:11:22 → 09:12:33 = **71 s** (failure)
- p50 wall-clock (parallel matrix) ≈ **70–80 s**, dominated by Windows.

### Dim 3 — CI cache strategy
Single `npm cache` via `actions/setup-node@v4` (`cache: 'npm'`). Cache-key = `package-lock.json` hash. **Complexity = 1.**

### Dim 4 — Schema sync overhead
**N/A.** Single language. JSON-on-the-wire snippets (`tests/snippet-protocol/v1/`) are versioned but consumed by one runtime.

### Dim 5 — Debug surface
**1 stack.** `node --inspect`, heap snapshot, `0x` for flame, `node --test --test-reporter=spec`.

### Dim 6 — Onboarding cost
Largest contributor pool (npm). New contributor time-to-first-PR ≈ 1–3 days (speculation, internal anecdotal).

### Dim 7 — Long-term maintenance
**Risk: persistent npm ecosystem volatility.** Concrete recurring pattern documented in this repo:
- Issue #14 — `uuid@11` ESM-only broke `require()` on fresh Linux/Node 18 install. Closed, but the *class* of bug recurs whenever a transitive dep makes the ESM jump (uuid@12 dropped CommonJS in October 2024 entirely; the next dep on telepty's tree to follow this curve will reproduce #14).
- Issue #15 — Daemon-singleton invariant broken by version mismatch; symptomatic of single-process supervisor model without process-isolation.

These are **not refactor-fixable**; they are structural costs of running JS for long-lived supervisor processes that cannot be hot-restarted.

---

## §4 Path B — Rust sidecar (bilingual transitional)

Architecture: Node daemon retained; PTY/multiplex/transport extracted to a Rust binary loaded via `cdylib + N-API` (preferred, in-process FFI) or stdio JSON-RPC subprocess (fallback). C2 spike validates which.

### Dim 1 — Initial rewrite cost
**~3,000–5,000 LOC of Rust** (PTY supervision + multiplexer + IPC frame). Estimate 4–6 person-weeks for a Rust-fluent contributor; 8–12 weeks if learning concurrently.

LOC anchor: `portable-pty` crate is ~3.5k Rust LOC and provides full cross-platform PTY abstraction; the sidecar is roughly that scope plus session/routing logic that telepty already has in JS.

### Dim 2 — CI build time per PR
**Modelled** (no empirical telepty Rust pipeline yet):
- Cold cargo build (release): **5–10 min** on GitHub-hosted ubuntu runners for a 5k-LOC binary with ~50 transitive crates (typical for portable-pty + tokio + serde stack).
- With `Swatinem/rust-cache@v2` + warm cache: **2–4 min** (Earthly/Depot benchmarks: 50–60% reduction).
- With `mozilla-actions/sccache-action`: **further 30–50%**, floor ≈ **90 s incremental**.
- Plus existing Node test job ~70 s in parallel.

**p50 wall-clock estimate: 2.5–5 min.**
**Multiplier vs Path A: 2.0x – 3.5x** (warm cache best case ~1.5x; cold cache worst case >5x).

This matches the deliberation concern's "1.5x to 2x permanent increase" *only when caching is fully tuned*. Default config will be worse.

### Dim 3 — CI cache strategy
**npm cache + cargo cache + (optionally) sccache cloud cache.** Three independent caches, three invalidation triggers (`package-lock.json`, `Cargo.lock`, `Cargo.toml`/feature flags). **Complexity ≈ 3, with an additional secret to manage if sccache-cloud is used.**

### Dim 4 — Schema sync overhead
This is the dimension cited in the source deliberation as **+10–15% per feature**. Mozilla application-services (Rust↔Kotlin/Swift FFI) explicitly documents the cost: any field change on the Rust side must be mirrored on the Node side or runtime exceptions/UB occurs. JSON across the boundary is what the deliberation reference describes; FlatBuffers/Protobuf reduce runtime cost but **add a schema-compile step**, not eliminate the contract-alignment cost.

For telepty, boundary-touching features include: `inject` flow, session-state events, mailbox messages, submit-gate signals — i.e. ≥30% of feature work. Net per-feature overhead **weighted across the roadmap ≈ 5–8%** rather than 10–15%, since not every feature crosses the boundary.

### Dim 5 — Debug surface
**2 stacks + IPC.** Node debugger for the CLI/MCP layer; `cargo flamegraph` / `tokio-console` / `gdb` for the sidecar; structured IPC trace (NDJSON or Protobuf wire dump) for boundary issues. Time-to-root-cause for boundary bugs **estimated 1.5–2x** Path A bug-fix cycles (speculation; no telepty data).

### Dim 6 — Onboarding cost
Rust pool is smaller than Node, but Rust hires are typically systems-strong (Tailscale, AWS Nitro, FANG infra). Time-to-first-PR for a Node-only contributor: **2–4 weeks** (must learn enough Rust to navigate sidecar). Pure Rust hires productive day 1 in sidecar but day 5+ in Node CLI.

### Dim 7 — Long-term maintenance
- **Pro**: PTY/ConPTY surface lives in Rust where the ecosystem (`portable-pty`, `portable-pty-psmux`) is already production-grade and tracks Windows pseudoconsole improvements (PSEUDOCONSOLE_RESIZE_QUIRK, WIN32_INPUT_MODE).
- **Pro**: Issues #14-class breakages cannot reach the supervisor core — a CommonJS/ESM npm rupture takes out the CLI but not the running daemon's PTY supervision.
- **Con**: Two ecosystems to track for security advisories (RustSec + npm audit). Two release cadences. Two sets of MSRV/Node-version policies.

---

## §5 Path C — Go full migration

### Dim 1 — Initial rewrite cost
**~10,000–15,000 LOC of Go.** Estimate 8–12 person-weeks for a Go-fluent contributor.

### Dim 2 — CI build time per PR
- Cold `go test ./...` for 10–15k LOC: **60–120 s**.
- With module cache (`actions/setup-go@v5` `cache: true`): **30–60 s**.
- **p50 wall-clock: 1.0–1.5 min — comparable or slightly faster than Path A.** Go's CI story is the strongest of the three.

### Dim 3 — CI cache strategy
Single `go mod` cache. **Complexity = 1.**

### Dim 4 — Schema sync overhead
**N/A.** Single language post-migration.

### Dim 5 — Debug surface
**1 stack.** `pprof`, `delve`, `go test -race`. Excellent.

### Dim 6 — Onboarding cost
Go pool is large (k8s, Docker, infra contributors). Time-to-first-PR ≈ 3–7 days.

### Dim 7 — Long-term maintenance trajectory **— DISQUALIFYING ISSUE**

**Go's `os/exec` cannot set the process attributes required for ConPTY on Windows.** This is a *language/stdlib-level* limitation, not a library gap:
- `creack/pty` issue #95 + #169: ConPTY support has been in flight since Windows 10; PRs #109 and #155 attempt to bridge but require non-stdlib process spawning.
- `aymanbagabas/go-pty` exists as a workaround library but explicitly notes: *"Windows requires updating the process running in the PTY with a special attribute to enable ConPty support, which is not possible with `os/exec`"* (referencing Go upstream issues #62708, #6271).
- The workaround is to fork-and-patch process spawning, which loses the simplicity argument that motivates picking Go in the first place.

Telepty's **single most important capability** is reliable PTY supervision across macOS/Linux/Windows. Path C trades Node's supervisor invariant problems for Go's ConPTY problems — a lateral move at best, a regression on Windows specifically (where Path A's Windows job is already the dominant CI failure mode per §3 Dim 2).

**Path C should be eliminated** unless someone produces a credible spike showing ConPTY works robustly through `aymanbagabas/go-pty` (or equivalent) for telepty's specific use cases (resize, suspend, keyboard input modes, Win32-input-mode).

---

## §6 Cross-path comparison matrix

| Dim | Path A (Node) | Path B (Rust sidecar) | Path C (Go full) |
|---|---|---|---|
| 1. Rewrite LOC | 0 | 3–5k Rust | 10–15k Go |
| 1. Person-weeks | <1 | 4–12 | 8–16 |
| 2. CI p50 wall-clock | **70–80 s** (measured) | 2.5–5 min (modelled) | 60–90 s (modelled) |
| 2. CI multiplier vs A | 1.0x | **2.0x–3.5x** | 1.0x–1.2x |
| 3. Cache surface | 1 (npm) | 3 (npm + cargo + sccache) | 1 (go mod) |
| 4. Schema sync overhead | 0% | **5–8% weighted** | 0% |
| 5. Debug stacks | 1 | 2 + IPC | 1 |
| 6. Time-to-first-PR | 1–3 days | 2–4 weeks | 3–7 days |
| 7. Ecosystem volatility | high (npm ESM rupture risk) | medium (RustSec + npm) | low |
| 7. Windows ConPTY support | acceptable (node-pty) | **excellent** (portable-pty) | **broken** (os/exec limitation) |
| 7. V1 vision (#12 native cwd/resume) | blocked | **enabled by Rust core** | enabled but ConPTY-blocked |

---

## §7 Cost breakdown — initial vs ongoing (per year)

Assuming team velocity = 50 PRs/year touching the supervisor core:

| Path | Initial (one-time) | Ongoing CI cost/year | Ongoing schema sync cost/year | Ongoing maintenance cost/year |
|---|---|---|---|---|
| A | ~0 | 50 PR × 80 s × N runners = baseline | 0 | 1–2 #14-class incidents = ~5 PD |
| B | 4–12 PW Rust + ~1 PW C2 spike | 50 PR × ~210 s = **2.6x baseline minutes** | 50 PR × ~7% × avg PR size = **~3.5 PR-equivalents/yr** | 1–2 RustSec advisories + 1–2 npm advisories = ~3 PD |
| C | 8–16 PW Go | 50 PR × ~75 s ≈ baseline | 0 | 1–2 ConPTY regressions on Windows = **unbounded risk** |

CI-minutes cost is small in absolute dollars on GitHub Actions for a small team (well under \$100/yr at this PR volume), but **wall-clock per PR is an engineering-velocity tax** that compounds.

---

## §8 Reference data (with cite dates)

### Empirical (from this repo)
- Telepty 0.3.5 LOC: `find ~/projects/aigentry-telepty -name "*.js" | xargs wc -l` → 16,175 (run 2026-05-10).
- Telepty CI run 25367739350 timing: `gh run view 25367739350 --repo dmsdc-ai/aigentry-telepty --json jobs` (run 2026-05-10).
- Telepty issues: `gh issue list --repo dmsdc-ai/aigentry-telepty --state all` (run 2026-05-10).
- Reference LOC: `gh api repos/<org>/<repo>/languages` for zellij, alacritty, wezterm, tmux (run 2026-05-10).

### Industry (web)
- **Rust CI duration**: Earthly, *Incremental Rust builds in CI* (https://earthly.dev/blog/incremental-rust-builds/); Depot, *Guide to faster Rust builds in CI* (https://depot.dev/blog/guide-to-faster-rust-builds-in-ci); LogRocket, *Optimizing CI/CD pipelines in Rust projects* (https://blog.logrocket.com/optimizing-ci-cd-pipelines-rust-projects/). Cited 2026-05-10.
- **sccache hit rate / improvement**: Depot, *Fast Rust Builds with sccache and GitHub Actions* (https://depot.dev/blog/sccache-in-github-actions); 50–55% build-time reduction with proper config. Cited 2026-05-10.
- **FFI schema sync cost**: Mozilla Hacks, *Crossing the Rust FFI frontier with Protocol Buffers* (https://hacks.mozilla.org/2019/04/crossing-the-rust-ffi-frontier-with-protocol-buffers/); mozilla/application-services issue #612 on FFI bookmarks contract. Cited 2026-05-10.
- **Discord Read States rewrite (Go→Rust)**: https://discord.com/blog/why-discord-is-switching-from-go-to-rust — relevant as evidence that *systems-grade* PTY/runtime work is increasingly Rust-favoured at infra level. Cited 2026-05-10.
- **uuid@12 CommonJS drop**: https://github.com/uuidjs/uuid/issues/881 — concrete confirmation of class-of-bug behind telepty issue #14. Cited 2026-05-10.
- **portable-pty crate (Path B feasibility evidence)**: https://lib.rs/crates/portable-pty (wezterm origin); https://docs.rs/portable-pty. Cited 2026-05-10.
- **Go ConPTY limitation (Path C disqualifier)**: creack/pty issue #169 (https://github.com/creack/pty/issues/169); Go upstream issues #62708, #6271; aymanbagabas/go-pty README. Cited 2026-05-10.

---

## §9 Self-criticism (Constitution Article 13)

### 9.1 Assumptions that could break

1. **"5–8% weighted schema sync cost"** is interpolated from Mozilla's narrative + my estimate that 30% of telepty features touch the boundary. If the actual fraction is 60% (likely if the V1 native-cwd/resume work in issue #12 lands heavily in the sidecar), this jumps to **8–12%**, which approaches the deliberation's 10–15% upper bound. **Action**: re-measure after first 5 sidecar features land; revise.
2. **"Cargo cold cache 5–10 min for 5k LOC + 50 deps"** assumes a typical dep tree (`tokio`, `serde`, `portable-pty`, `tracing`). If the sidecar pulls a heavier surface (e.g., a full HTTP stack for cross-machine transport), cold builds could exceed 15 min and warm-cache mitigation degrades.
3. **Path C disqualification rests on Go ConPTY status as of 2026-05.** If `aymanbagabas/go-pty` reaches feature parity (Win32-input-mode, resize, passthrough mode) and the upstream Go issues land, Path C re-opens. **Action**: reconfirm before any final commit; the situation has moved slowly but is not frozen.
4. **C2 PoC outcome is unknown.** The Path B recommendation is *contingent*. If C2 reveals that `cdylib + N-API` is unstable under Node 22+ or that subprocess IPC has unacceptable latency for the inject-submit hot path, Path B's "incremental migration" framing collapses and the cost picture shifts toward Path C-shaped numbers.

### 9.2 Areas with insufficient data

- **No empirical telepty Rust CI baseline** — all Path B CI numbers are modelled from third-party benchmarks. The C2 spike should produce real numbers; this report should be revised after.
- **No empirical schema-sync cost** for telepty's boundary in particular — the Mozilla figure is suggestive but their boundary (Rust↔mobile platform code) is structurally different from Rust↔Node N-API.
- **Time-to-first-PR estimates** are speculative. No internal data; figures are anchored to public hiring reports and may not generalise.

### 9.3 Bias surface

- I am writing this for an orchestrator that has already invested in Rust/Q'''-bis ideation. **Confirmation bias toward Path B is a real risk.** I have actively worked to keep Path A as a credible recommendation under C2-FAIL conditions, and to disqualify C on technical evidence rather than ergonomic preference.
- Sunk-cost framing (Article 5): *"we already have a working Node daemon, why rewrite anything"* is the inverse bias. I have surfaced it in §3 Dim 7 by noting that ecosystem volatility is a *recurring* not *one-time* cost on Path A — i.e. the sunk-cost argument is weaker than it looks because the Node investment is not a stable asset.
- **Selection bias in reference projects**: zellij/alacritty/wezterm are all *successful* Rust terminal projects. There may be abandoned-mid-rewrite cases (failed Rust attempts) that would weaken the Path B story. I did not find them in the available evidence; this is an open data gap.

---

## §10 Verdict + decision dependencies

### 10.1 Final recommendation

```
IF C2 (cdylib + N-API PoC) PASSES:
    → Path B (Rust sidecar bilingual transitional)
        Rationale: maximises reuse of telepty 0.3.x surface,
        moves PTY/ConPTY supervision to the language ecosystem
        (Rust/portable-pty) that has demonstrated production maturity,
        and accepts a quantified ~2x CI multiplier + ~5–8% per-feature
        schema-sync overhead in exchange for V1 vision unblocking
        (issues #12, #15) and Windows ConPTY robustness.

IF C2 FAILS or is inconclusive:
    → Path A (Node 0.3.x maintained) + targeted hardening of #14, #15
        Rationale: avoid paying full bilingual cost without the
        cdylib win that justifies it. Re-evaluate Path B at next
        roadmap inflection (likely after V1 spec freeze).

DO NOT SELECT Path C
    Rationale: Go's stdlib-level inability to set ConPTY process
    attributes attacks telepty's primary value proposition. The
    other Path C wins (CI parity, single language, single cache)
    are real but irrelevant if the supervisor cannot reliably
    drive Windows pseudoconsoles.
```

### 10.2 Decision dependency graph

```
                    ┌──────────────────────┐
                    │ C2 cdylib+N-API PoC  │
                    └──────────┬───────────┘
                               │
                ┌──────────────┴──────────────┐
                │                             │
              PASS                          FAIL
                │                             │
                ▼                             ▼
        ┌──────────────┐              ┌──────────────┐
        │   PATH B     │              │   PATH A     │
        │ Rust sidecar │              │ Node 0.3.x   │
        │  bilingual   │              │  maintained  │
        └──────┬───────┘              └──────────────┘
               │
               ▼
   ┌───────────────────────┐
   │ Subsequent decisions: │
   │ - cargo-chef adoption │
   │ - sccache cloud cfg   │
   │ - schema format       │
   │   (NDJSON now,        │
   │    Protobuf at scale) │
   └───────────────────────┘
```

---

## §11 Open questions (for separate grill / spike)

1. **Schema format for IPC frame** (Path B): NDJSON (cheap, evolves with code) vs Protobuf/FlatBuffers (faster, schema-checked, adds compile step). Defer until C2 and first sidecar feature lands; pick based on measured frame rate not theory.
2. **cdylib hot-reload story**: if the sidecar is loaded as N-API cdylib, what is the upgrade path when the Rust binary changes but the Node daemon is mid-session? This is exactly issue #15-class for the bilingual world.
3. **Cross-machine transport** (#11 native autossh): does this live in Rust or Node? Node already has `cross-machine.js`; moving to Rust means rewriting. Probably stays in Node initially.
4. **Test fixture strategy**: `tests/snippet-protocol/v1/` is consumed by Node tests; if the producer moves to Rust, do fixtures move too, or does Rust generate them and Node consume? Decision affects schema-sync overhead estimate above.
5. **What is C2's actual scope**? This report assumed a thin PTY-spawn-and-IO PoC. If C2 attempts to validate the *full* sidecar surface, its result becomes more decisive but its execution cost grows. Worth confirming with the orchestrator before C2 begins.
6. **Failed-Rust-rewrite case studies**: §9.3 flagged a selection-bias gap. Should be filled by deliberate negative-case search (e.g., projects that started a Rust rewrite and reverted) before final commit.

---

*End of report. NO commit performed; awaiting orchestrator review per brief.*
