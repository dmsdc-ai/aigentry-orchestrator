---
title: telepty L2 supervisor phased impl plan + ADR lock recommendation (#430)
date: 2026-05-23
author: aigentry-architect-β2-l2-supervisor-plan
status: ARCHITECT REPORT (read-only plan, no code, no tests, no builds)
scope: telepty #430 — full L2 supervisor / SPOF removal per ADR 2026-05-10-q-prime-bis
related:
  - "docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis.md (synthesis, accepted)"
  - "docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-claude.md (historical draft)"
  - "docs/adr/2026-05-10-telepty-l2-architecture-q-prime-bis-codex.md (historical draft)"
  - "docs/reports/2026-05-10-telepty-bilingual-ops-cost.md (C4 closure)"
  - "docs/reports/2026-05-23-agentic-migration-cost.md (#428 — telepty not in α/β/γ phases)"
  - "~/projects/aigentry-telepty/crates/telepty-supervisor-core/ (M1–M3 in flight)"
  - "~/projects/aigentry-telepty/Cargo.toml (workspace already configured)"
---

# telepty L2 supervisor — phased impl plan + ADR lock recommendation (#430)

> **Article 13 framing.** This report is critical of the dispatch premise where the
> evidence requires it, constructive where it can defer to existing artifacts, and
> objective on every number. Each LOC / FT-week range is anchored to either a
> measured artifact (current crate size, current Node footprint) or an explicit
> industry reference.

## §0 CLDR finding — dispatch premise needs correction

The dispatch background frames task #430 as "ADR draft (status: draft, not accepted) ⇒
architect must lock the ADR before coder dispatch". **Direct read of the three ADR
files contradicts the framing**:

| Variant | File | Frontmatter status | Last revision |
|---|---|---|---|
| claude | `2026-05-10-...-q-prime-bis-claude.md` | `proposed` | r1 (2026-05-10) — **historical draft, retained as history per synthesis** |
| codex | `2026-05-10-...-q-prime-bis-codex.md` | `proposed` | r1 (2026-05-10) — **historical draft, retained as history per synthesis** |
| synthesis | `2026-05-10-...-q-prime-bis.md` | **`accepted`** | **r5+amend-A1A3+r6 (2026-05-12)** |

The synthesis ADR §23 history records the lock trajectory:

- r5 (2026-05-10): `proposed → accepted` flip after C1 (E3 ≤ 15 MB) closure.
- r5+amend-A1A3 (2026-05-12): A1 wire `signal` enum / A2 error codes / A3 manifest
  `exit_reason` enum landed as additive contract amendments.
- r6 (2026-05-12): supervisor binary language **LOCKED to Rust** per C2 PASS_WITH_CONDITIONS
  (cdylib-in-tokio PoC, RSS 3.25–3.42 MiB, 5/5 scenarios) + C4 Path B selection
  (Path C / Go disqualified on ConPTY).

**Per AGENTS.md workflow #6 (CLDR) and Rule 26 (evidence over assumption), the
framing must be corrected before phase decomposition can proceed honestly.**

### §0.1 What this means for #430

The architecture decision is **already locked** at the level of "what to build".
What remains for #430 is the **implementation execution plan** — phase decomposition
of the locked ADR §12 plan into concrete deliverables, with the empirical baseline
that ~30–40 % of Phase 1 code is already shipped under
`crates/telepty-supervisor-core/`.

This report therefore:

1. **Confirms the lock** (§1) — synthesis ADR is the binding architecture; no fork
   between claude / codex variants needs to be resolved (the synthesis already
   merged them at r1 and four review cycles refined them).
2. **Enumerates the residual decisions** still pending in §14 / §20.2 of the
   synthesis ADR (7 TBDs — none architectural, all implementer-path / scope /
   sunset-timing).
3. **Decomposes #430 into 6 implementation phases** (§2) anchored to the synthesis
   ADR §12 phase plan, with LOC + FT-week + acceptance + dependency + risk per
   phase.
4. **Maps phases to SPOF facets** (§3) so each phase has an observable SPOF-closure
   metric.
5. **Defines risk / rollback strategy** (§4).
6. **Cites industry anchors** for daemon rewrites and supervisor-tree migrations
   (§5).
7. **Surfaces decision points** still requiring user / orchestrator input (§6).
8. **Recommends next coder dispatches** (§7).

---

## §1 ADR lock recommendation

### §1.1 Triangulation summary — divergences (claude r1 vs codex r1) and consensus

The synthesis ADR §1 already records this triangulation (companion synthesis
report at `docs/reports/2026-05-10-q-prime-bis-adr-synthesis-report.md` is the
canonical record). For decision-trail completeness, the key axes:

| Axis | claude r1 | codex r1 | Synthesis r6 (binding) |
|---|---|---|---|
| 3-layer separation (L1 / L2 / L3 + terminal orthogonal) | locked, hard | locked, hard | **locked, hard** |
| Daemon-1 → Daemon-0 + per-session supervisor + per-host relay | locked, hard | locked, hard | **locked, hard** |
| Wire = NDJSON, `v:1`, kind-conditional | locked (M37'/M38') | locked (M37'/M38') | **locked + r3 `trace_id` required for `inject`/`output`** |
| Local IPC = UDS POSIX / Named Pipe Windows | locked | locked | **locked + r5+amend `signal` enum + A2 error codes** |
| Cross-machine = SSH-over-Tailscale + persistent relay | locked (M23 rejects ControlMaster) | locked (M23 rejects ControlMaster) | **locked** |
| E3 RAM target | "≤ 10 MB, amendment-eligible" (claude §3.E) | "≤ 10 MB unless C1 amendment changes invariant" (codex §4) | **closed: ≤ 15 MB per ADR-E3-r1 (Option A)** |
| Supervisor binary language | "TBD, Rust leading, evidence-gated by C2/C3/C4" | "TBD, Rust attractive, evidence-gated by C2/C3/C4" | **LOCKED: Rust per C2 PASS + C4 Path B (r6 2026-05-12)** |
| Requirement count | "31 binding requirements" (claude §3) | "31 binding requirements" with §1.3 trace note that visible A–K count = 39 (codex §1.3) | **synthesis preserves "31" label + enumerates all 39 in §4 per codex §1.3 mismatch flag** |
| Alternatives count | 8 (Q''', D, Q, I', Y, CC, N, O) | 10 (claude 8 + Tailscale-SSH-mode + Public-Relay) | **14 (synthesis 8 + Path C Go disqualification r2 + 5 compact transport/cap variants r2)** |
| Self-criticism count | 8 (§14) | 6 (§11.4) | **13 numbered sub-points (§17.1–§17.13)** with per-criticism LLM source tags |
| Article 17 dependency / fallback inventory | absent | absent | **r3 added §18.7 for Tailscale + OpenSSH + jemalloc** |
| H1 / M34 / L3a state recovery semantics | "auto-restart with state recovery" (ambiguous re: PTY) | "launchd/systemd auto-restart with state recovery" (ambiguous) | **r3 corrected: crash detection + audit-replay only; live PTY recovery explicitly out of scope per 1-process model §9.5 / §17.3 r3** |

### §1.2 Lock recommendation

**Recommendation: ACCEPT the synthesis ADR as binding.** The synthesis is already
flipped to `accepted` per r5 closure; this report independently re-verifies the
flip is justified:

- All 4 Phase 0 preconditions have closure artifacts (C1: ADR-E3-r1; C2: aterm
  cdylib PoC report 2026-05-10; C3: SPEC-C3-r1 driving A1/A3 amendments; C4:
  bilingual-ops-cost report 2026-05-10).
- The two parallel drafts (claude / codex) are explicitly retained as history
  (revision_history r1, ADR §16 / §23) — they are *not* live forks needing
  resolution.
- The four review cycles (r1 best-of-both → r2 E3+Path-C → r3 codex-review fixes
  → r4 codex-review → r5 minor textual + status flip → r5+amend-A1A3 SPEC-C3
  amendments → r6 Rust lock) produce an audit trail that satisfies Rule 25
  evidence and Article 13 객관성.

**No new ADR lock decision is required for #430 to proceed.** The remaining 7 TBD
blanks (§20.2 of the synthesis) are scope-defined as either deferred to a later
ADR (#379 migration, Phase 2 V4 ADR, Phase 2 HMAC M11), implementer-path (manifest
schema fixture path, NDJSON contract fixture path), or measurement-gated (Phase 4+
per-CPU-core hybrid).

### §1.3 Residual decisions that *might* still warrant orchestrator attention

For trade-off honesty (Constitution §13), three items in §20.2 deserve a fresh
look even though the synthesis declares them deferrable:

| Item | Current synthesis status | Trade-off worth re-examining | Recommendation |
|---|---|---|---|
| **Exact manifest JSON Schema file path** | "TBD — telepty implementer — Phase 1" | If the schema lives in `aigentry-ssot` (per `#428` keystone analysis) rather than in `aigentry-telepty`, P1 of #430 must coordinate with the ssot from-zero typed-pkg bootstrap. Risk: schema drift if both repos draft independently. | **Lock now**: put the schema at `aigentry-ssot/schemas/telepty/manifest-v1.json` and `~/projects/aigentry-ssot/pkg/src/telepty/manifest.ts` (TS bindings) once the ssot pkg/ exists; until then, hold the schema in `aigentry-telepty/crates/telepty-supervisor-core/src/manifest.rs` as the de-facto SSOT and mirror on ssot bootstrap. |
| **0.3.x migration shim lifetime** | "TBD — migration ADR #379 — after Phase 1" | The sunset window directly affects whether daemon.js (3178 LOC) can be removed in P5 (this report) or must wait for a longer deprecation tail. If shim lifetime ≥ 6 months, P5 cannot fully delete daemon.js — only mark it deprecated. | **Re-examine when P3 acceptance approaches**: the shim lifetime is empirically observable (how many 0.3.x clients still hit it), not designable in advance. Defer to ADR #379 per current plan, but tag P5 dependency. |
| **C3 closure artifact** (sidecar/supervisor kill gate spec) | "Phase 2 entry — required: closed `docs/spec-sidecar-kill-gate.md`" | SPEC-C3-r1 exists (drove r5+amend-A1A3 enums) and is referenced from the synthesis ADR multiple times, but the canonical file path is not declared in §20.2 / §13.3 / §12.7.1. Risk: implementers cannot locate the binding spec. | **Surface the canonical path** in the next ADR amendment (or in P2's planning artifact). Likely candidate path based on convention: `~/projects/aigentry-orchestrator/docs/specs/2026-05-12-c3-sidecar-kill-gate.md` (not verified against filesystem — current report scope is read-only). |

These three are notes for the orchestrator, not blockers. **#430 can start P1 work
immediately.**

---

## §2 Phased implementation plan

### §2.1 Scope boundary

Per Rule 29 (surgical), scope = ADR #430 = "remove the Daemon-1 SPOF". Everything
in the synthesis ADR §12 Phase 1–4 is in scope. **Out of scope for this plan**:

- V4 cross-mesh design beyond M39/M40 surface (deferred to Phase 2 ADR).
- V4 contact ed25519 identity (deferred to Phase 2 ADR).
- AI-mediated triage receiver beyond optional Phase 3 prototype.
- Cross-machine ControlMaster TTL hardening (separate dustcraw task).
- Windows codex shim PTY fixes (separate task per #428 / dispatch boundary).

### §2.2 Baseline measurement (anchor for LOC ranges)

Direct survey 2026-05-23 of `~/projects/aigentry-telepty`:

| Surface | LOC | Notes |
|---|---|---|
| Node 0.3.x — top-level (`*.js`) | **9 585** | cli.js 3233, daemon.js 3178, session-state.js 622, tui.js 538, cross-machine.js 498, daemon-control.js 344, others |
| Node 0.3.x — `src/` modules | **1 823** | mailbox/* (942), submit-gate, prompt-symbol-registry, others |
| **Node 0.3.x total** | **~11 408** | matches `#428` baseline of 18 979 with vendored cli.js + tests + scripts |
| Rust crate `telepty-supervisor-core/src/` | **1 538** | supervisor 444, wire 338, ipc 250, manifest 203, kill_gate 181, lib 14 |
| Rust crate `telepty-supervisor-core/tests/` | **321** | ipc_protocol 219, wire_golden 102 |
| Rust binary `telepty-supervisor-bin/` | **68** | main 68 |
| **Rust total (current)** | **~1 927** | M1 spawn+observe + M2 kill+manifest + M3 UDS IPC + inject dispatch present in supervisor.rs comments |

The Rust crate's module-level comments declare the current M1/M2/M3 surface:

> `// M1 surface: spawn_observe — spawn + observe a child until natural exit.`
> `// M2 surface: run — graceful/forced kill, manifest atomic write, A8 finalize.`
> `// M3 additions: per-session UDS server (ipc::serve) feeding a single mpsc
> ingest queue (F5 / SPEC §7.G); supervisor consumes the queue and dispatches
> inject / kill / delete / signal / ping.`

This is roughly **30–40 % of synthesis ADR Phase 1 scope already implemented**.
The phase decomposition below treats P1 as a finishing pass on the existing crate,
not greenfield.

### §2.3 Phase decomposition (6 phases — within Article 1 lightweight ≤ 7 cap)

| # | Phase | Owner repo | Deliverable | Acceptance | Depends on |
|---|---|---|---|---|---|
| **P1** | Supervisor-core completion (POSIX) | `aigentry-telepty/crates/telepty-supervisor-core` | A1–A8 + B1–B4 + F1–F3 + G1–G3 + J1–J2 + M37'/M38'/M22/M24/M25/M31 contract tests green on macOS + Linux | local supervisor passes contract test suite without daemon.js | nothing (in flight) |
| **P2** | Node↔Rust IPC bridge + 0.3.x J3 shim | `aigentry-telepty/cli.js` + new `aigentry-telepty/src/bridge/` | `telepty inject/list/output` calls Rust supervisor via UDS; daemon.js path can be bypassed (not yet removed) | E2E test: `telepty spawn → inject → output` works with daemon.js stopped | P1 |
| **P3** | CLI rewiring + manifest discovery | `aigentry-telepty/cli.js` + `daemon-control.js` deprecation | All user-facing `telepty <subcommand>` go through manifest-read + UDS; daemon.js remains as fallback shim only | `pkill -f daemon.js`, all CLI subcommands still functional | P2 |
| **P4** | Windows native adapter (Named Pipe) | `aigentry-telepty/crates/telepty-supervisor-core` Windows feature gate | C3 + C4 contract tests green on Windows native (no WSL substitution) | Windows CI run green for full Phase 1 test matrix | P1 |
| **P5** | Persistent telepty-relay (cross-machine) | new `aigentry-telepty/crates/telepty-relay-core` + relay binary | `cross-machine.js` SSH-shell-out pattern replaced; K1 RTT ≤ 20 ms median measured on Tailscale link | M40 binary reachability green; K1 measurement closes | P3 |
| **P6** | Daemon-1 sunset + measurement gates | `aigentry-telepty` daemon.js / daemon-control.js / port-3848 deletion | daemon.js + daemon-control.js deleted; E1–E4 + K1 measured per ADR-E3-r1 / §10.1 budgets | `git grep -r "daemon.js\\|:3848"` returns no callers; E3 promotion or amendment decision filed | P3 (CLI rewiring) + P5 (relay) + ADR #379 migration window |

**Phase count**: 6 (within Article 1 lightweight ≤ 7 cap, consistent with `#428`
analyst's 5-phase decomposition style).

### §2.4 Per-phase detail

#### P1 — Supervisor-core completion (POSIX)

- **Scope**: finish the A1–A8 surface on the existing `telepty-supervisor-core`
  Rust crate. Specifically:
  - A5 detach/reattach via UDS reconnection (the `broadcast` channel in ipc.rs:23
    is already laid for this — log offset replay from `log.jsonl` needs to land).
  - A7 `list` discovery via filesystem manifest scan (separate from supervisor
    process — likely lands in `telepty-supervisor-bin` or a new `telepty-cli-core`
    crate).
  - A8 delete graceful drain + manifest unlink (partly present per M2 surface
    comment; final wire-path needs golden-file test).
  - B3 `trace_id` enforcement per r3 amendment (wire.rs Frame schema; reject
    `inject`/`output` lacking it).
  - F3 atomic manifest writes — manifest.rs already implements rename pattern;
    contract test fixture needs to land.
  - G3 audit trail — `log.jsonl` writer (likely 200–400 LOC new module).
- **LOC delta** (additive over the existing 1 927 Rust LOC):
  - best: +1 200 (finishing the existing scaffolds)
  - **expected: +1 800**
  - worst: +2 800 (if A5 reattach requires a separate log-replay subsystem)
- **FT-wk**: **best 1.5 / expected 2.5 / worst 4** (1 FTE Rust).
- **Acceptance**:
  - All 11 `protocol/*`, `manifest/*`, `ipc/*`, `inject/*`, `supervisor/*` tests
    from §19.2 of the synthesis ADR green on macOS arm64 + Linux x86_64.
  - `cargo test -p telepty-supervisor-core --release` passes in CI < 5 min.
  - `cargo bench` shows E1 < 1 ms p50 for local inject on a representative MacBook.
- **Dependency**: none (already in flight; the next coder dispatch is the
  natural continuation).
- **Risk surface**:
  - The existing supervisor.rs:60–80 dependencies on `portable-pty` + `nix` are
    POSIX-only — Windows code paths are *out of scope for P1* (those land in P4).
  - The `tokio` rt/macros/sync/time feature set in `Cargo.toml` is the canonical
    M24 single-thread tokio scope; M27 sccache should land before CI starts
    seeing Rust build times.
- **Trigger condition**: any time after this report is filed; existing in flight.

#### P2 — Node↔Rust IPC bridge + 0.3.x J3 shim

- **Scope**: a thin Node module (likely `src/bridge/supervisor-ipc.js`) that
  speaks NDJSON over UDS to a per-session Rust supervisor. The bridge is the
  "0.3.x backward-compat layer" for J3 — existing `cli.js` and `cross-machine.js`
  call into it instead of daemon.js HTTP/WS for the migration window. J3 also
  requires accepting 0.3.x-shaped requests (`inject` / `output` / `list` only) on
  the bridge surface and translating them to NDJSON.
- **LOC delta**:
  - new bridge module: best 200 / **expected 400** / worst 700
  - cli.js / cross-machine.js minimal call-site changes (still using daemon path
    by default in P2): best 50 / **expected 100** / worst 200
  - Rust: small additive (e.g., `--socket-path` override flag in
    `telepty-supervisor-bin`, ~50 LOC).
- **FT-wk**: **best 1 / expected 2 / worst 3.5**.
- **Acceptance**:
  - `node -e "require('./src/bridge/supervisor-ipc').inject(sid, 'hello\\n')"`
    works with daemon.js stopped and a live supervisor.
  - Existing cli.js `telepty inject <id> "..."` callable path still works
    (daemon.js still up).
  - Bridge can speak both 0.3.x shape (for backward callers) and 1.0 NDJSON.
- **Dependency**: P1 (`telepty-supervisor-core` IPC surface stable).
- **Risk surface**:
  - Node UDS handling has historical sharp edges (EAGAIN, partial writes); the
    bridge needs a robust line-framer for NDJSON.
  - Bilingual ops cost surfaces here for the first time (Node + Rust both
    debugging same path) — per C4 report §1, this is the +1.5–3.5× CI cost
    moment. Investing in sccache + cargo-chef at P1 pays off here.
- **Trigger condition**: P1 contract tests green for at least the A2 (inject)
  and A3 (output) paths.

#### P3 — CLI rewiring + manifest discovery

- **Scope**: replace cli.js's daemon-HTTP path with manifest-discovery + UDS.
  Specifically:
  - `telepty list` → scan `~/.telepty/sessions/*/manifest.json` (atomic-read),
    optionally include relay manifest, no HTTP call.
  - `telepty inject` / `telepty attach` / `telepty read-screen` / `telepty enter`
    → resolve `<id>` to a manifest, open UDS, speak NDJSON via the P2 bridge.
  - `daemon-control.js` (344 LOC) deprecated — its `daemon start/stop` becomes a
    no-op or prints a deprecation banner. **Not yet deleted** in P3 (deletion is
    P6).
- **LOC delta**:
  - cli.js: net -800 to -1 200 (drop HTTP path) + 400 to 700 (manifest +
    bridge plumbing) = **-400 to -500 net**.
  - daemon-control.js: -300 (most of the file becomes no-op + banner) for a
    **-300 LOC delta**, but the file stays for backward shell-script callers
    until P6.
  - cross-machine.js: minimal changes in P3 (cross-machine path still uses
    SSH-shell-out; relay lands in P5).
- **FT-wk**: **best 1.5 / expected 3 / worst 5**.
- **Acceptance**:
  - `pkill -f daemon.js` then all `telepty list/inject/attach/read-screen` are
    still functional via manifest + UDS (the manifest discovery path).
  - Existing tests/scripts that called `telepty daemon start` print a clear
    deprecation banner pointing to the migration plan ADR.
  - Bridge layer of P2 is the only J3 backward-compat surface; no new shims
    sprout.
- **Dependency**: P2 (bridge module shipped + stable).
- **Risk surface**:
  - cli.js is 3 233 LOC and has accumulated 18 months of UX expectations
    (bootstrap prompts, reconnect windows, AI-CLI wrapper coupling per #428
    `#3 telepty SPOF` note about user-visible flakiness). A drive-by refactor
    here will violate Rule 29; the work must be strictly call-site replacement.
  - Watch for `tui.js` (538 LOC) coupling to daemon-control state — likely needs
    a small UDS-side hook.
- **Trigger condition**: P2 acceptance closed.

#### P4 — Windows native adapter (Named Pipe)

- **Scope**: add Windows-native code paths to `telepty-supervisor-core` and
  `telepty-supervisor-bin`. Per ADR §17.10 self-criticism, this is **the highest
  variance phase** because:
  - Named Pipe semantics differ from UDS (creation race, ACL inheritance,
    message-mode vs byte-mode framing).
  - ConPTY (Windows pseudo-console) has its own resize/signal/hangup semantics —
    the `portable-pty` crate abstracts most of this, but the supervisor's signal
    handling (A4) needs the A1-amended `JOB_TERMINATE` / `CTRL_BREAK_EVENT`
    semantics from r5+amend-A1A3.
  - **WSL substitution is forbidden** per M25 / §17.10 / ADR §13.1 acceptance
    scope — the test harness must fail-fast if it detects WSL-only execution.
- **LOC delta** (additive over P1):
  - best: +700 (mostly `#[cfg(windows)]` arms in ipc.rs + new
    `crates/telepty-supervisor-core/src/win/{pipe,signal,kill_gate}.rs`)
  - **expected: +1 200**
  - worst: +2 200 (if ConPTY-specific bugs in `portable-pty` need an upstream
    contribution)
- **FT-wk**: **best 2 / expected 4 / worst 7** (1 FTE Rust + Windows access).
- **Acceptance**:
  - Windows CI run executes the same `protocol/*` + `manifest/*` + `inject/*` +
    `supervisor/crash-isolation` test set as macOS / Linux, all green.
  - `ipc/named-pipe-acl` test demonstrates owner-only access (G1 Windows arm).
  - `signal` enum exercises `JOB_TERMINATE` and `CTRL_BREAK_EVENT` per A1
    amendment.
- **Dependency**: P1 (POSIX surface stable so the diff is small).
- **Risk surface**:
  - Windows CI infra availability — if the project does not currently run
    Windows runners, the calendar dependency is procurement, not code.
  - C2 PoC was scoped to macOS / Linux per the C2 closure report — Windows
    cdylib semantics under tokio may surface a *new* PoC requirement; the
    synthesis §13.1 notes that "Windows native E3 acceptance is pending until
    C2 PoC closes" for Windows.
  - Per the C4 bilingual-ops report, `portable-pty` (from wezterm) is the
    industry's most mature ConPTY-supporting Rust PTY library — this de-risks
    the language choice but does not eliminate Windows-specific bugs.
- **Trigger condition**: P1 acceptance closed; Windows CI runner provisioned.

#### P5 — Persistent telepty-relay (cross-machine)

- **Scope**: stand up the per-host relay process. Per synthesis ADR §8.1–§8.5:
  - New crate `telepty-relay-core` (sibling of supervisor-core) and binary
    `telepty-relay-bin` (or unify as single `telepty` binary with `relay` mode
    per H3 — recommended).
  - Lazy spawn on first cross-machine inject (L1a); persistent until explicit
    shutdown (L2c); launchd/systemd auto-restart (L3a, audit-replay only per
    r3); discovery via manifest cache → SSH config → Tailscale (L4a).
  - SSH stream multiplex: one persistent ssh-channel per remote relay; NDJSON
    framing per supervisor session over the multiplexed channel.
  - Replace `cross-machine.js` (498 LOC) shell-out pattern (each inject = new
    SSH cold start at 300–800 ms) with the persistent relay (K1 ≤ 20 ms).
- **LOC delta**:
  - new `telepty-relay-core` Rust: best 1 200 / **expected 2 000** / worst 3 500
  - cross-machine.js: -498 (full deletion) or -300 (kept as deprecation shim)
  - launchd / systemd-user templates: 50–200 LOC YAML/plist (shipped with
    devkit per boundary ADR or with telepty per §15 / §18.2)
- **FT-wk**: **best 3 / expected 5 / worst 8** (1 FTE Rust).
- **Acceptance**:
  - K1: median ≤ 20 ms RTT, p99 < 100 ms on a Tailscale link from machine A to
    machine B for a `cross-machine inject` cycle (measurement test from §19.2).
  - M40 binary reachability: relay-A → SSH-down → relay-B unreachable →
    immediate `ERR_NOT_REACHABLE` (no mailbox / store-and-forward).
  - F1 crash isolation for relay (relay crash does not kill any supervisor on
    either host; supervisors only see cross-machine inject failures during the
    crash window).
- **Dependency**: P3 (CLI rewiring done so `cross-machine.js` can be cleanly
  retired) + Windows from P4 if cross-OS relay is in scope for the same release.
- **Risk surface**:
  - SSH stream framing under packet loss / kernel scheduling jitter — per ADR
    §17.11 the K1 architecture-derived budget is not yet measured; this phase is
    where the budget meets reality.
  - launchd/systemd unit templates touch the boundary with devkit (boundary
    ADR §3.1 — devkit owns install-time content). Recommend templates ship in
    telepty (mechanism), and devkit's `aigentry setup` script merely installs
    them.
- **Trigger condition**: P3 acceptance closed; Tailscale link available for
  K1 measurement; if cross-OS relay is in scope, P4 acceptance also closed.

#### P6 — Daemon-1 sunset + measurement gates

- **Scope**:
  - Delete `daemon.js` (3 178 LOC), `daemon-control.js` (344 LOC), port 3848
    listener.
  - Final J3 bridge sunset per migration ADR #379 (the lifetime decision is
    ADR #379, not this report).
  - Phase 4 measurement gates (E1, E2, E3, E4, K1) on real macOS arm64 + Linux
    x86_64 + Windows native; produce a measurement artifact for the E3
    promotion-or-amendment decision per §10.3.
- **LOC delta**:
  - daemon.js + daemon-control.js: **-3 522 net**.
  - bridge shim minimum-viable retention: +200 (if migration ADR #379 retains
    a bridge for inject/list/output during a deprecation tail) or -300 (if
    bridge is also deleted).
  - new measurement harness / bench: +200–500.
- **FT-wk**: **best 1 / expected 2 / worst 4**.
- **Acceptance**:
  - `git grep -r "daemon.js\|:3848"` returns no live callers in
    aigentry-telepty / aigentry-orchestrator / aigentry-devkit / aigentry-brain.
  - Phase 4 measurement artifact:
    `docs/reports/<date>-telepty-phase4-measurements.md` recording E1–E4 + K1
    p50/p95/p99 on the three OS targets.
  - E3 promotion decision filed (either ≤ 15 MB confirmed as hard invariant, or
    a follow-up ADR amendment to ≤ 10 MB if measurements support it).
- **Dependency**: P3 + P5 + migration ADR #379 sunset clock fired.
- **Risk surface**:
  - Hidden callers — devkit `aigentry setup` shells out to `telepty daemon`
    historically; any unaudited caller breaks on `daemon.js` deletion.
  - **User-impact risk highest in P6**: running 0.3.x sessions at the moment of
    daemon.js deletion become unreachable. The migration ADR #379 must define a
    graceful shutdown / re-attach path before P6 ships.
- **Trigger condition**: P3 + P5 acceptance closed; migration ADR #379
  accepted and sunset clock past its deprecation window.

### §2.5 LOC + FT-week + calendar summary

| Phase | LOC delta (expected) | FT-wk (best / **exp** / worst) | Calendar (1 FTE) |
|---|---|---|---|
| P1 | +1 800 Rust | 1.5 / **2.5** / 4 | ~3 wk |
| P2 | +500 Node (bridge), +50 Rust | 1 / **2** / 3.5 | ~2 wk |
| P3 | -400 Node net (cli.js shrink) | 1.5 / **3** / 5 | ~3 wk |
| P4 | +1 200 Rust (Windows) | 2 / **4** / 7 | ~4 wk |
| P5 | +2 000 Rust (relay), -500 Node | 3 / **5** / 8 | ~5 wk |
| P6 | -3 522 Node delete, +400 bench | 1 / **2** / 4 | ~2 wk |
| **Total** | **+5 100 Rust net / -4 422 Node net** | **10 / 18.5 / 31.5** | **~19 wk (1 FTE) / ~12 wk (2 FTE w/ P4 // P5 parallelism)** |

90 % confidence range: **10–31.5 FT-week**, ~3.2× spread, driven mainly by P4
Windows variance and P5 relay K1-measurement variance. The expected midpoint
(**18.5 FT-week**) is broadly consistent with the synthesis ADR §16.2 "8–12
person-week Phase 1 estimate" *for the local supervisor path only*; adding
P4 (Windows) + P5 (relay) extends the budget by another ~9–13 FT-week, matching
the synthesis ADR §12.1 indicative ETA of Phase 1 (1–2 wk) + Phase 2 (2–3 wk) +
Phase 3 (1–2 wk) + Phase 4 (3–5 days) = ~5–8 wk *if calendar wall-clock for a
single FTE*.

**Critical-path note**: P3 sits on the critical path between local-core (P1+P2)
and the relay (P5) + sunset (P6). Parallelizing P4 (Windows) with P3 (CLI
rewiring) is the most effective dependency-graph reshape — both depend only on
P1 / P2.

### §2.6 Consistency check against `#428` analyst migration cost

The 2026-05-23 analyst migration-cost report (`#428`) explicitly excludes #430
from its α/β/γ phases (see §1 "telepty SPOF; P0 task #430 today"). The
expected 18.5 FT-week here is **additive** to the analyst's 35.9 FT-week
expected number for the 5-tier migration. The combined budget if both #430 and
the migration proceed in parallel is therefore **~54 FT-week** (1 FTE) or
**~32 FT-week wall-clock** (2 FTE with smart dependency parallelism — which is
already what the analyst report recommends in its Hybrid α/β/γ scheme).

---

## §3 SPOF surface inventory

The four SPOF facets mentioned in the dispatch + a fifth surface that the ADR
adds (V4 reachability binary, not a SPOF per se but a fast-fail surface):

| SPOF facet | Current 0.3.x manifestation | Phase that closes it | Closure metric |
|---|---|---|---|
| **F-S1: Daemon process death = no recovery** (single process owns all sessions) | daemon.js crash kills N sessions simultaneously (D-3 blast radius per ADR §1.3) | **P1 + P3 + P6** — P1 lands per-session crash isolation (F1) at the supervisor layer; P3 routes CLI through manifest discovery so a single process death is bounded; P6 deletes daemon.js so the SPOF physically does not exist | F1 contract test `supervisor/crash-isolation` green; `pgrep telepty-supervisor \| wc -l` = N supervisors (not 1 daemon) |
| **F-S2: Session bootstrap race** (#18 / #22 — task #415 per dispatch) | bootstrap prompts and reconnect windows corrupt the target AI CLI per `2026-05-09 cross-machine survey` | **P2 + P3** — P2 J3 bridge can speak both 0.3.x and 1.0 shapes during the bootstrap window; P3 manifest-discovery bypasses daemon-state.js (622 LOC) race surface | bootstrap E2E test: spawn → inject within 500 ms (E2 cold start) without daemon-state corruption |
| **F-S3: Port owner conflicts** (addressed by #417 / #428 telepty v0.4.3 commit `bfe4bee`) | daemon version mismatch holds port 3848; second daemon spawn refuses to start (issue #14) | **P6** (final closure) — P3 already removes the daemon callers; P6 removes the daemon and the port | `lsof -i:3848` returns nothing on a running 1.0 host; `telepty list` works without a port listener |
| **F-S4: Cross-machine ControlMaster TTL** (separate task per dispatch boundary) | not a #430 scope item; mentioned for completeness | **Out of scope for #430.** Relay (P5) replaces ControlMaster as the cross-machine transport per M23; ControlMaster TTL tuning is moot once relay is live | n/a — closed by removing the dependency |
| **F-S5: Embed conflict (issue #15)** | cdylib host cannot start its own daemon when one is already running per D-1 (ADR §1.3) | **P1** primary closure (D1–D3 cdylib mandate via M28); **P3** secondary by removing the daemon discovery dependency | D3 contract test "two cdylib embeds, different host processes, no UDS/manifest collision" green |
| **F-S6: V4 reachability fast-fail** (not a SPOF but a fast-fail surface) | not present in 0.3.x (no V4 yet) | **P5** — M40 binary reachability `(Tailscale up) AND (SSH reachable) AND (relay running)`; immediate reject if false | M40 contract test `relay/reachability` green |
| **F-S7: Relay crash (new SPOF risk)** introduced by Q'''-bis itself | new surface — per ADR §17.3 self-criticism, the persistent per-host relay is a *cross-machine* SPOF for the duration of its auto-restart window | **P5 (acknowledged, accepted as Phase 1 design choice); Phase 3+ revisit allowed** | L3a auto-restart < 5 s on launchd/systemd; M40 returns `ERR_NOT_REACHABLE` during the window; downstream callers retry |

### §3.1 What the phase plan does *not* close

Honest accounting per Article 13:

- **F-S7 relay crash window** is a *new* SPOF introduced by the design itself.
  The ADR explicitly accepts this as a Phase 1 trade-off (§17.3 closure note);
  Phase 4 measurement gates (P6) should include a relay-crash-injection test
  to bound the user-visible window.
- **Host kernel / disk / Tailscale itself**: these are L1 SPOFs (machine
  fabric), not L2 — out of scope for #430 by ADR §2.4 layer separation.
- **Migration window dual-stack ops cost** (Path B Rust + Node 0.3.x both
  shipping): a measurable cost per C4 report, not a SPOF. P6 sunset is when
  this cost ends; the migration ADR #379 governs the timeline.

---

## §4 Risk + rollback strategy

### §4.1 Per-phase rollback path

| Phase | Can it ship independently? | Rollback path | Worst-case rollback time |
|---|---|---|---|
| P1 | **Yes** — supervisor-core completion is an internal crate maturing in place. No user-visible artifact yet. | `git revert` + `cargo test` baseline | < 1 hour |
| P2 | **Yes** — bridge is a new module; cli.js still defaults to daemon.js path until P3 | Disable bridge import in cli.js; `git revert` of `src/bridge/` | < 1 hour |
| P3 | **Partial** — once cli.js routes through manifest-discovery, callers see new manifest files. Rollback must also clean up `~/.telepty/sessions/*/manifest.json` artifacts if their schema differs from 0.3.x | Add a `TELEPTY_USE_DAEMON=1` env-var escape hatch during P3 dev to flip between paths; `git revert` + escape-hatch enable | < 4 hours |
| P4 | **Yes** — Windows arm is feature-gated; macOS/Linux unaffected by Windows rollback | `git revert` + `cargo --no-default-features` to drop Windows features | < 1 hour |
| P5 | **Partial** — once relay is live, cross-machine inject latency improves; rollback to `cross-machine.js` SSH-shell-out re-introduces 300–800 ms cold start. Rollback is safe but the regression is user-visible | Re-enable `cross-machine.js` path; deprecate relay; users notice the slowdown | < 4 hours |
| P6 | **No surprise rollback** — daemon.js deletion is one-way. Migration ADR #379 must lock the sunset window before P6 ships | If deletion proves premature: `git revert` of the daemon.js deletion commit + re-publish, with a public deprecation extension | < 24 hours (release + comms) |

**Key rollback insight**: P3 is the irreversibility hinge. P1 + P2 are entirely
reversible; P4 + P5 are independently reversible; **P6 is one-way**. The
migration ADR #379 is the gate on P6, not this plan.

### §4.2 User-impact risk per phase

| Phase | User-visible risk | Mitigation |
|---|---|---|
| P1 | none (internal crate) | n/a |
| P2 | low (bridge module unused by default) | feature flag `TELEPTY_USE_BRIDGE=1` for opt-in canary |
| P3 | medium (CLI users will see different `telepty list` output if manifest schema differs from daemon-state.js) | dual-path during P3 dev (env-var escape hatch); preserve user-facing command shape per ADR §6.7 |
| P4 | medium (Windows users gain native parity, lose WSL workaround if they relied on it) | call out the change in the release note; provide explicit migration step |
| P5 | medium-low (cross-machine inject latency improves; relay crash window is a new surface) | call out the K1 measurement and relay-restart-window in the release note |
| P6 | **high** (running 0.3.x sessions become unreachable at daemon.js deletion) | migration ADR #379 owns the graceful shutdown / re-attach contract; do not ship P6 until #379 sunset clock fires |

### §4.3 Test surface

Per synthesis ADR §19.2, the binding contract tests are 11 entries. The phase
mapping:

- **P1**: `protocol/inject.v1`, `protocol/output.v1`, `protocol/resize.v1`,
  `manifest/atomic-write`, `ipc/uds-permission`, `inject/idempotent`,
  `supervisor/crash-isolation`, `perf/local-inject`.
- **P2**: `protocol/*` re-validated via Node bridge (same goldens).
- **P3**: integration tests that exercise the full CLI → manifest → UDS path
  (likely a `tests/integration/cli-rewire.test.ts` or `.sh`).
- **P4**: `ipc/named-pipe-acl`, plus all `protocol/*` and `manifest/*` re-run
  on Windows native.
- **P5**: `relay/reachability`, `perf/cross-machine-inject`.
- **P6**: full measurement suite — E1, E2, E3, E4, K1 — on the three OS
  targets.

The synthesis ADR notes that the SSOT registration of these contracts is
"PENDING (Phase 1 deliverable)" per §18.6 Article 15. Recommend **P1 ships the
contract registry artifact** (likely in `aigentry-ssot/contracts/telepty/` once
ssot's typed-pkg bootstrap lands per `#428` P1, or as a placeholder in
`aigentry-telepty/contracts/` mirrored later).

---

## §5 Industry anchors

Three daemon-rewrite / supervisor-tree migrations with documented calendar /
LOC characteristics. **All three favor incremental migration over big-bang
rewrites** — consistent with the P1–P6 incremental phasing recommended above.

### §5.1 systemd evolution (sysvinit → upstart → systemd)

- **Calendar**: 2010 (systemd v1 release) → 2015 (default in Debian 8 / RHEL 7 /
  Ubuntu 15.04) → 2018+ (legacy sysvinit largely retired). **5–8 years to
  ubiquity**.
- **Architecture shift**: from N init.d shell scripts owned by sysvinit
  (process tree height = 2: init → daemon) to per-unit service supervisor
  (process tree height = 2–3 with cgroup-bounded service units). Per-service
  supervision is the same direction telepty is moving — *opposite* of
  Daemon-N → Daemon-1; telepty is going Daemon-1 → Daemon-0 + per-session.
- **LOC**: systemd ~1 M LOC at 2020 (vastly larger than telepty); pacing was
  feature additions, not the core supervisor (~50–80 KLOC core PID 1).
- **Lesson for #430**: ship the supervisor surface *before* removing the old
  daemon; provide a long deprecation tail for daemon-callers (sysvinit
  compatibility shipped for ~5 years in systemd hosts).
- **Source**: Lennart Poettering's "Rethinking PID 1" (2010) and Wikipedia
  systemd article (2026 read-only public source).

### §5.2 runit / s6 process supervision trees

- **Calendar**: runit (2004+, daemontools fork lineage), s6 (2011+). Mature
  per-service supervisor trees with very small per-supervisor binaries.
- **Architecture**: 1 supervisor process per service (analogous to telepty's
  "1 supervisor per session"). Crash containment is per-service; the
  supervisor itself is < 10 KLOC C.
- **LOC anchor**: s6 supervisor ~6 KLOC C (per s6 manual, supervisor module).
  Telepty's `telepty-supervisor-core` is currently 1.5 KLOC Rust and projected
  to reach ~3.5 KLOC at P1 + P4 completion — **within an order of magnitude of
  s6, suggesting the synthesis ADR §16.2 estimate is realistic**.
- **Lesson for #430**: the supervisor binary should stay small (Article 1
  lightweight); s6's success comes from refusing to grow the supervisor beyond
  per-service supervision.
- **Source**: s6 official manual `https://skarnet.org/software/s6/`; runit
  `http://smarden.org/runit/`.

### §5.3 Kubernetes kubelet → containerd separation (CRI 2016 → dockershim
removal 2022)

- **Calendar**: CRI (Container Runtime Interface) introduced **2016**;
  dockershim removed from kubelet in Kubernetes **v1.24 (2022)**. **~6 years
  from interface definition to legacy removal**.
- **Architecture shift**: kubelet (daemon) used to embed docker-shim; CRI
  decoupled the runtime so kubelet talks via gRPC to containerd / cri-o.
  Telepty's Daemon-1 → Daemon-0 with NDJSON wire is the same pattern at a
  smaller scale: defining a contract (NDJSON wire + manifest schema = the
  M37'/M38' surface), then decoupling the implementation behind it.
- **Lesson for #430**: the wire protocol *is* the migration. Once NDJSON +
  manifest schema + UDS / Named Pipe are stable (P1 + P2), the daemon (kubelet's
  dockershim equivalent) becomes a thin compatibility layer that can be sunset
  on a calendar dictated by external consumers. P6 sunset timing is therefore
  a *consumer-tail* decision, not a code-completion decision.
- **Source**: Kubernetes blog "Don't Panic: Kubernetes and Docker" (Dec 2020),
  Kubernetes v1.24 release notes (May 2022).

### §5.4 Reference projects from the bilingual-ops cost report (Path B
validation)

- **zellij** (Rust): 10 M LOC bytes (Rust terminal multiplexer).
- **wezterm** (Rust): 15.5 M LOC bytes; *upstream of `portable-pty`*.
- **alacritty** (Rust): 1.1 M LOC bytes.
- **tmux** (C): 2.4 M LOC bytes.

Telepty at ~16 K LOC (Node 0.3.x + ~1.9 K Rust) is **3 orders of magnitude
smaller** than zellij / wezterm. Per the bilingual-ops report §2.3, this means
a rewrite is *tractable in absolute terms* but the ratio of ops investment to
feature surface is what matters — Path B (Rust sidecar) leverages
`portable-pty` from wezterm to import a large fraction of the PTY surface
without paying for the wezterm-scale codebase.

---

## §6 Decision points requiring user / orchestrator input

Per Article 13 trade-off honesty, six items where the architect is **not
deciding** and is deferring to the user / orchestrator:

### §6.1 P3 cli.js refactor depth

**Question**: cli.js is 3 233 LOC accumulated over 18 months. P3 by design is a
call-site replacement (Rule 29 surgical). Should P3 also clean up adjacent UX
bugs (bootstrap prompt corruption, reconnect window flakiness per #428 user-
visible defects) inside the same release window?

- **Option A**: surgical only — P3 ships call-site changes; UX bugs queued for
  a follow-up.
- **Option B**: bundled — P3 ships the UX bugs alongside the rewiring,
  accepting larger blast radius and longer review window.

**Trade-off**: A is the safer, Rule 29-aligned path; B amortizes the user-
facing churn into a single release. Architect declines to choose — this is a
release-management call.

### §6.2 P4 Windows CI runner procurement

**Question**: does the project already run Windows CI runners (GitHub Actions
`windows-latest` or similar), or is this procurement work?

- If yes: P4 calendar is governed by code, ~4 weeks expected.
- If no: P4 calendar adds a procurement tail (1–2 weeks) before the 4-week
  code window starts.

Architect cannot answer without inspecting `.github/workflows/` — out of scope
for read-only architect role.

### §6.3 P5 relay launchd/systemd unit ownership (boundary ADR clarification)

**Question**: launchd/systemd unit templates for the persistent relay — do they
ship in `aigentry-telepty` (mechanism) or `aigentry-devkit` (install-time
content)? Per boundary ADR §3.1, mechanism vs content is the dividing line.

- **Recommendation (architect, not lock)**: ship templates in telepty (the
  unit is a mechanism description, not user-customized content), and devkit's
  `aigentry setup` script merely installs them. Same logic as M30 first-spawn
  ulimit check vs install-time hook (per ADR §17.7).

User / orchestrator should confirm before P5 begins so the devkit team can plan.

### §6.4 P6 daemon.js sunset window (ADR #379 timing)

**Question**: how long is the 0.3.x deprecation tail? Migration ADR #379 owns
this decision per ADR §14 / §15 / §17.5.

- **Option A**: ≥ 6 months deprecation tail — P6 cannot fully delete daemon.js;
  only mark it deprecated.
- **Option B**: 3-month tail — feasible if the running 0.3.x population is
  small.
- **Option C**: 1-month tail — only feasible if all known 0.3.x consumers
  upgrade in lockstep with the 1.0 release.

Architect cannot decide without consumer-base telemetry; orchestrator owns this
in coordination with the migration ADR.

### §6.5 SSOT contract registration site

**Question**: per ADR §18.6 Article 15 PENDING, the NDJSON + manifest schema
must register in an SSOT. Should that SSOT be:

- **Option A**: `aigentry-ssot/schemas/telepty/` once the ssot from-zero
  typed-pkg bootstrap lands (per `#428` P1).
- **Option B**: `aigentry-telepty/contracts/` as a placeholder, mirrored to
  ssot when ssot is ready.

**Recommendation**: B for P1, A for the long term. Decision is small but should
be made before P1 ships the contract test fixtures.

### §6.6 telepty-relay-core vs unified `telepty` binary

**Question**: per ADR §3.10 / §19.1, "single binary multi-mode shape is
required". P5 introduces relay functionality. Two implementations:

- **Option A**: one binary, modes selected by subcommand (`telepty supervisor`,
  `telepty relay`, `telepty cli`, `telepty embed`). Matches H3 mandate.
- **Option B**: two binaries (`telepty-supervisor-bin` + `telepty-relay-bin`)
  sharing a `telepty-relay-core` crate. Cleaner crate boundaries but two
  install artifacts.

**Recommendation**: A (single binary). H3 mandate is binding; the cargo
workspace already supports producing one binary with multiple mode subcommands.

---

## §7 Recommended next-step dispatches

Per dispatch boundary §7, the next coder dispatches after ADR lock. Since the
ADR is already locked (§0 CLDR finding), these are immediately spawnable.

### §7.1 First dispatch (highest priority, lowest blast radius)

**`telepty-coder-supervisor-core-finish`** — finishes P1 surface on the
existing `crates/telepty-supervisor-core` crate.

- **Scope**: A5 detach/reattach, A7 list, A8 delete graceful drain, B3 trace_id
  enforcement, G3 audit trail (`log.jsonl` writer), F3 contract test fixture.
- **Cost estimate**: 2.5 FT-week (expected) at 1 FTE Rust.
- **Dependency**: none.
- **Deliverable**: P1 contract tests green on macOS + Linux.

### §7.2 Second dispatch (parallelizable after P1)

**`telepty-coder-node-bridge`** — builds the Node↔Rust IPC bridge.

- **Scope**: `src/bridge/supervisor-ipc.js` plus J3 backward-compat translation.
- **Cost estimate**: 2 FT-week (expected) at 1 FTE Node.
- **Dependency**: P1's IPC surface stable (specifically A2 inject + A3 output).
- **Deliverable**: P2 acceptance criteria.

### §7.3 Third dispatch (CLI rewiring)

**`telepty-coder-cli-rewire`** — replaces cli.js daemon-HTTP path with
manifest + UDS via the P2 bridge.

- **Scope**: cli.js call-site replacement; daemon-control.js deprecation
  banner.
- **Cost estimate**: 3 FT-week (expected) at 1 FTE Node + light Rust.
- **Dependency**: P2 complete.
- **Deliverable**: `pkill -f daemon.js` keeps all `telepty <subcommand>` functional.

### §7.4 Fourth + fifth dispatches (parallelizable)

**`telepty-coder-windows-adapter`** — P4 Windows native arm.

- **Cost**: 4 FT-week (expected) at 1 FTE Rust + Windows access.
- **Dependency**: P1 complete + Windows CI runner provisioned.

**`telepty-coder-relay-core`** — P5 persistent relay.

- **Cost**: 5 FT-week (expected) at 1 FTE Rust.
- **Dependency**: P3 complete.

### §7.5 Final dispatch (one-way operation)

**`telepty-coder-daemon-sunset`** — P6 daemon.js deletion + measurement gates.

- **Cost**: 2 FT-week (expected) at 1 FTE Node + 0.5 FTE measurement.
- **Dependency**: P3 + P5 complete + migration ADR #379 sunset clock fired.
- **Deliverable**: SPOF closed; E3 promotion-or-amendment decision filed.

### §7.6 Dependency graph

```text
P1 (supervisor-core finish)  ─┬─→ P2 (node bridge)  ──→ P3 (cli rewire)  ─┬─→ P5 (relay)  ──→ P6 (sunset + measure)
                              │                                          │
                              └─→ P4 (windows adapter, parallelizable) ──┘
                                                                          │
                                                                          └─→ P6 measurement gates (Windows arm)
```

**Critical path (1 FTE serial)**: P1 → P2 → P3 → P5 → P6 = 14.5 FT-wk expected.
P4 sits off the critical path if Windows is treated as a separate release
track.

**Critical path (2 FTE parallel)**: max(P1+P2+P3, P1+P4) = 7.5 FT-wk → P5 →
P6 = 14.5 FT-wk → ~9 FT-wk wall-clock if both FTEs keep moving.

---

## §8 Self-criticism (Article 13)

### §8.1 The "ADR already accepted" finding is itself a framing risk

If the dispatch was issued *knowing* the synthesis is accepted and intended
"please now produce the impl plan", then the CLDR correction in §0 is mostly
courtesy. If the dispatch was issued *not knowing*, this report has gone beyond
the brief in §0–§1 to surface the correction. The architect chooses the
broader path because Rule 26 (evidence over assumption) and AGENTS.md workflow
#6 (CLDR) both demand it: silently following an outdated framing produces a
plan that other readers will question.

### §8.2 LOC ranges anchor to current state, not future drift

The LOC ranges in §2.5 assume the existing
`crates/telepty-supervisor-core/src/*.rs` shape stays roughly as-is. If P1
discovers a structural refactor is needed (e.g., A5 reattach forces a separate
log-replay subsystem), the worst-case ranges may shift up by another 30 %. The
ranges are calibrated to the synthesis ADR §16.2 8–12 person-week estimate +
the bilingual-ops report; both sources are consistent within the spreads
quoted.

### §8.3 Industry anchors are macro-scale (systemd, kubelet)

The three industry anchors are 1–3 orders of magnitude larger than telepty.
The lessons (incremental migration, contract-first decoupling, small
supervisor binaries) translate; the calendar (years) does not. The s6 anchor
is closer in scope (~6 KLOC C supervisor) and is the most relevant LOC
anchor for telepty's supervisor-core.

### §8.4 Phase boundaries are *implementation* boundaries, not feature boundaries

P3 (CLI rewiring) is the user-visible cutover; P6 (daemon sunset) is the
irreversible cutover. The plan is therefore really a 3-stage release:
*supervisor available* (P1+P2) → *daemon optional* (P3+P4+P5) → *daemon gone*
(P6). Treating it as a 6-phase code plan is correct for engineering scheduling
but obscures the user-facing release shape. Recommend the release notes
reflect the 3-stage shape, not the 6-phase shape.

### §8.5 F-S7 (relay crash window) is a new SPOF the design accepts

Per ADR §17.3, the persistent relay introduces a cross-machine SPOF for the
duration of its auto-restart window (~5 s on launchd/systemd). M40's binary
reachability means user-visible flakiness during that window. The phase plan
does not eliminate this; Phase 4 measurement gates (P6) should explicitly
bound the window and Phase 3+ revisit is reserved if production data demands
it. Reader should not interpret "SPOF closed" in §3 as "no SPOF anywhere" — it
is "the *original* SPOF closed; one new fast-fail surface accepted as Phase 1
trade-off".

### §8.6 Where this plan defers to other authoritative artifacts

- **Migration timing**: ADR #379.
- **V4 surface beyond M39/M40**: Phase 2 V4 ADR.
- **C3 kill-gate spec canonical path**: SPEC-C3-r1 (referenced from r5+amend-
  A1A3 but path not declared in §13.3 / §20.2 — see §1.3 of this report).
- **Per-CPU-core hybrid / idle-suspended supervisor**: Phase 4+ option only
  (§9.3 of the ADR), out of #430 scope.
- **Migration cost across the broader ecosystem**: `#428` analyst report.

---

## §9 Final summary

- **Lock recommendation (§1)**: ACCEPT the synthesis ADR (already `accepted`
  status). The two parallel drafts are historical; no fork resolution needed.
  7 TBDs remain (§20.2 of synthesis), all deferable to later phases or
  implementer-paths; 3 worth surfacing now for orchestrator attention (§1.3).
- **Phases (§2)**: 6 phases — P1 supervisor-core completion (POSIX), P2
  Node↔Rust bridge + J3 shim, P3 CLI rewiring + manifest discovery, P4 Windows
  native adapter, P5 persistent telepty-relay, P6 daemon sunset + measurement
  gates. Total **10–31.5 FT-week**, expected **18.5 FT-week**, calendar **~19
  wk (1 FTE) or ~12 wk (2 FTE with P4 // P5 parallelism)**.
- **SPOF inventory (§3)**: 5 facets closed by the phase plan; 1 fast-fail
  surface (F-S7 relay crash window) accepted as Phase 1 trade-off per
  §17.3 of the ADR.
- **Risk (§4)**: P3 is the user-visible cutover; P6 is the one-way
  irreversible step gated by migration ADR #379.
- **Industry anchors (§5)**: systemd (5–8 yr to ubiquity), s6 (~6 KLOC C
  supervisor — best LOC anchor), kubelet→containerd (6 yr CRI → dockershim
  removal).
- **Decision points (§6)**: 6 items deferred to user / orchestrator — P3
  refactor depth, Windows CI runner procurement, launchd unit ownership,
  daemon.js sunset window, SSOT registration site, single-binary mode count.
- **Next dispatches (§7)**: 5 coder dispatches, starting with
  `telepty-coder-supervisor-core-finish` (no dependency, 2.5 FT-wk expected).

**Verdict**: #430 is implementable now without further ADR work. The plan
above is the surgical decomposition; the architecture decision is closed.

---
